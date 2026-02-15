import {
  createLegacyBrainService,
  logger,
  type BrainMemoryFact,
  type BrainService,
  type StateService,
} from '@swarm/core';

type BrainWriteMode = 'legacy' | 'dual' | 'canonical';
type BrainReadMode = 'legacy' | 'hybrid' | 'canonical';

interface BrainModeOverrides {
  writeMode?: BrainWriteMode;
  readMode?: BrainReadMode;
}

interface CanonicalMemoryModule {
  remember: (avatarId: string, fact: string, about?: string, userId?: string) => Promise<{ saved: boolean }>;
  recall: (avatarId: string, query: string, userId?: string) => Promise<{
    facts: Array<{ fact: string; about?: string; timestamp: number; strength?: number }>;
  }>;
}

let canonicalMemoryModulePromise: Promise<CanonicalMemoryModule | null> | null = null;

const BRAIN_METRICS_LOG_INTERVAL_MS = Number.parseInt(
  process.env.BRAIN_METRICS_LOG_INTERVAL_MS || '',
  10
) || 60_000;

const brainTelemetry = {
  writes: 0,
  reads: 0,
  writesByMode: {
    legacy: 0,
    dual: 0,
    canonical: 0,
  } as Record<BrainWriteMode, number>,
  readsByMode: {
    legacy: 0,
    hybrid: 0,
    canonical: 0,
  } as Record<BrainReadMode, number>,
  canonicalModuleLoads: 0,
  canonicalModuleUnavailable: 0,
  writeCanonicalFailures: 0,
  readCanonicalFailures: 0,
  hybridFallbackReads: 0,
  lastLoggedAt: 0,
};

function maybeLogBrainTelemetry(): void {
  const now = Date.now();
  if (now - brainTelemetry.lastLoggedAt < BRAIN_METRICS_LOG_INTERVAL_MS) {
    return;
  }
  brainTelemetry.lastLoggedAt = now;

  logger.info('Runtime brain telemetry snapshot', {
    event: 'brain_metrics',
    subsystem: 'brain',
    writes: brainTelemetry.writes,
    reads: brainTelemetry.reads,
    writesByMode: brainTelemetry.writesByMode,
    readsByMode: brainTelemetry.readsByMode,
    canonicalModuleLoads: brainTelemetry.canonicalModuleLoads,
    canonicalModuleUnavailable: brainTelemetry.canonicalModuleUnavailable,
    writeCanonicalFailures: brainTelemetry.writeCanonicalFailures,
    readCanonicalFailures: brainTelemetry.readCanonicalFailures,
    hybridFallbackReads: brainTelemetry.hybridFallbackReads,
    logIntervalMs: BRAIN_METRICS_LOG_INTERVAL_MS,
  });
}

function readWriteMode(overrides?: BrainModeOverrides): BrainWriteMode {
  if (overrides?.writeMode === 'legacy' || overrides?.writeMode === 'dual' || overrides?.writeMode === 'canonical') {
    return overrides.writeMode;
  }
  const raw = (process.env.BRAIN_WRITE_MODE || 'legacy').toLowerCase();
  if (raw === 'dual' || raw === 'canonical') return raw;
  return 'legacy';
}

function readReadMode(overrides?: BrainModeOverrides): BrainReadMode {
  if (overrides?.readMode === 'legacy' || overrides?.readMode === 'hybrid' || overrides?.readMode === 'canonical') {
    return overrides.readMode;
  }
  const raw = (process.env.BRAIN_READ_MODE || 'legacy').toLowerCase();
  if (raw === 'hybrid' || raw === 'canonical') return raw;
  return 'legacy';
}

async function loadCanonicalMemoryModule(): Promise<CanonicalMemoryModule | null> {
  if (!canonicalMemoryModulePromise) {
    canonicalMemoryModulePromise = (async () => {
      brainTelemetry.canonicalModuleLoads++;
      try {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore - optional runtime import; handlers package does not have a direct static dependency
        const memoryModule = await import('@swarm/admin-api');
        if (typeof memoryModule.remember !== 'function' || typeof memoryModule.recall !== 'function') {
          brainTelemetry.canonicalModuleUnavailable++;
          logger.warn('Canonical memory module missing required exports', {
            event: 'brain_canonical_exports_missing',
          });
          maybeLogBrainTelemetry();
          return null;
        }
        logger.info('Canonical memory module loaded for runtime brain', {
          event: 'brain_canonical_module_loaded',
          subsystem: 'brain',
        });
        maybeLogBrainTelemetry();
        return {
          remember: memoryModule.remember,
          recall: memoryModule.recall,
        };
      } catch (error) {
        brainTelemetry.canonicalModuleUnavailable++;
        logger.warn('Canonical memory module unavailable; using legacy brain path', {
          event: 'brain_canonical_module_unavailable',
          error: error instanceof Error ? error.message : String(error),
        });
        maybeLogBrainTelemetry();
        return null;
      }
    })();
  }

  return canonicalMemoryModulePromise;
}

function dedupeFacts(facts: BrainMemoryFact[]): BrainMemoryFact[] {
  const seen = new Set<string>();
  const deduped: BrainMemoryFact[] = [];

  for (const fact of facts) {
    const dedupeKey = `${fact.fact}::${fact.about || ''}::${fact.userId || ''}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    deduped.push(fact);
  }

  return deduped;
}

export function createRuntimeBrainService(
  stateService: StateService,
  modeOverrides?: BrainModeOverrides
): BrainService {
  const legacyBrain = createLegacyBrainService(stateService);

  return {
    async remember(avatarId: string, fact: string, about?: string, userId?: string) {
      const writeMode = readWriteMode(modeOverrides);
      brainTelemetry.writes++;
      brainTelemetry.writesByMode[writeMode]++;

      if (writeMode === 'legacy') {
        const result = await legacyBrain.remember(avatarId, fact, about, userId);
        logger.info('Brain remember completed', {
          event: 'brain_remember',
          subsystem: 'brain',
          avatarId,
          writeMode,
          effectiveFrom: modeOverrides?.writeMode ? 'avatar' : 'env',
          source: result.source,
        });
        maybeLogBrainTelemetry();
        return result;
      }

      const canonicalModule = await loadCanonicalMemoryModule();

      if (writeMode === 'canonical') {
        if (!canonicalModule) {
          brainTelemetry.writeCanonicalFailures++;
          throw new Error('BRAIN_WRITE_MODE=canonical requires canonical memory module availability');
        }

        await canonicalModule.remember(avatarId, fact, about, userId);
        const result = {
          saved: true,
          source: 'canonical' as const,
          canonicalSaved: true,
        };
        logger.info('Brain remember completed', {
          event: 'brain_remember',
          subsystem: 'brain',
          avatarId,
          writeMode,
          effectiveFrom: modeOverrides?.writeMode ? 'avatar' : 'env',
          source: result.source,
          canonicalSaved: true,
        });
        maybeLogBrainTelemetry();
        return result;
      }

      // dual write mode
      let legacySaved = false;
      let canonicalSaved = false;

      await legacyBrain.remember(avatarId, fact, about, userId);
      legacySaved = true;

      if (canonicalModule) {
        try {
          await canonicalModule.remember(avatarId, fact, about, userId);
          canonicalSaved = true;
        } catch (error) {
          brainTelemetry.writeCanonicalFailures++;
          logger.warn('Dual-write canonical remember failed', {
            event: 'brain_dual_write_canonical_error',
            avatarId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const result = {
        saved: legacySaved || canonicalSaved,
        source: 'dual' as const,
        legacySaved,
        canonicalSaved,
      };
      logger.info('Brain remember completed', {
        event: 'brain_remember',
        subsystem: 'brain',
        avatarId,
        writeMode,
        effectiveFrom: modeOverrides?.writeMode ? 'avatar' : 'env',
        source: result.source,
        legacySaved,
        canonicalSaved,
      });
      maybeLogBrainTelemetry();
      return result;
    },

    async recall(avatarId: string, query: string, userId?: string) {
      const readMode = readReadMode(modeOverrides);
      brainTelemetry.reads++;
      brainTelemetry.readsByMode[readMode]++;
      if (readMode === 'legacy') {
        const result = await legacyBrain.recall(avatarId, query, userId);
        logger.info('Brain recall completed', {
          event: 'brain_recall',
          subsystem: 'brain',
          avatarId,
          readMode,
          effectiveFrom: modeOverrides?.readMode ? 'avatar' : 'env',
          source: result.source,
          factCount: result.facts.length,
          queryLength: query.length,
        });
        maybeLogBrainTelemetry();
        return result;
      }

      const canonicalModule = await loadCanonicalMemoryModule();

      if (readMode === 'canonical') {
        if (!canonicalModule) {
          brainTelemetry.readCanonicalFailures++;
          throw new Error('BRAIN_READ_MODE=canonical requires canonical memory module availability');
        }
        const result = await canonicalModule.recall(avatarId, query, userId);
        const response = {
          source: 'canonical' as const,
          facts: result.facts.map((item) => ({
            ...item,
            userId,
            source: 'canonical' as const,
          })),
        };
        logger.info('Brain recall completed', {
          event: 'brain_recall',
          subsystem: 'brain',
          avatarId,
          readMode,
          effectiveFrom: modeOverrides?.readMode ? 'avatar' : 'env',
          source: response.source,
          factCount: response.facts.length,
          queryLength: query.length,
        });
        maybeLogBrainTelemetry();
        return response;
      }

      // hybrid mode: canonical first, fallback to legacy, then merge.
      const mergedFacts: BrainMemoryFact[] = [];
      let usedLegacyFallback = false;

      if (canonicalModule) {
        try {
          const canonicalResult = await canonicalModule.recall(avatarId, query, userId);
          mergedFacts.push(...canonicalResult.facts.map((item) => ({
            ...item,
            userId,
            source: 'canonical' as const,
          })));
        } catch (error) {
          brainTelemetry.readCanonicalFailures++;
          usedLegacyFallback = true;
          logger.warn('Hybrid-read canonical recall failed, falling back to legacy', {
            event: 'brain_hybrid_read_canonical_error',
            avatarId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        usedLegacyFallback = true;
      }

      if (mergedFacts.length === 0 || usedLegacyFallback) {
        brainTelemetry.hybridFallbackReads++;
        const legacyResult = await legacyBrain.recall(avatarId, query, userId);
        mergedFacts.push(...legacyResult.facts.map((item) => ({
          ...item,
          source: 'legacy' as const,
        })));
      }

      const result = {
        source: 'hybrid' as const,
        facts: dedupeFacts(mergedFacts),
      };
      logger.info('Brain recall completed', {
        event: 'brain_recall',
        subsystem: 'brain',
        avatarId,
        readMode,
        effectiveFrom: modeOverrides?.readMode ? 'avatar' : 'env',
        source: result.source,
        factCount: result.facts.length,
        queryLength: query.length,
        usedLegacyFallback,
      });
      maybeLogBrainTelemetry();
      return result;
    },
  };
}
