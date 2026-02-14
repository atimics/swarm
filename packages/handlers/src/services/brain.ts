import {
  createLegacyBrainService,
  logger,
  type BrainMemoryFact,
  type BrainService,
  type StateService,
} from '@swarm/core';

type BrainWriteMode = 'legacy' | 'dual' | 'canonical';
type BrainReadMode = 'legacy' | 'hybrid' | 'canonical';

interface CanonicalMemoryModule {
  remember: (avatarId: string, fact: string, about?: string, userId?: string) => Promise<{ saved: boolean }>;
  recall: (avatarId: string, query: string, userId?: string) => Promise<{
    facts: Array<{ fact: string; about?: string; timestamp: number; strength?: number }>;
  }>;
}

let canonicalMemoryModulePromise: Promise<CanonicalMemoryModule | null> | null = null;

function readWriteMode(): BrainWriteMode {
  const raw = (process.env.BRAIN_WRITE_MODE || 'legacy').toLowerCase();
  if (raw === 'dual' || raw === 'canonical') return raw;
  return 'legacy';
}

function readReadMode(): BrainReadMode {
  const raw = (process.env.BRAIN_READ_MODE || 'legacy').toLowerCase();
  if (raw === 'hybrid' || raw === 'canonical') return raw;
  return 'legacy';
}

async function loadCanonicalMemoryModule(): Promise<CanonicalMemoryModule | null> {
  if (!canonicalMemoryModulePromise) {
    canonicalMemoryModulePromise = (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore - optional runtime import; handlers package does not have a direct static dependency
        const memoryModule = await import('@swarm/admin-api');
        if (typeof memoryModule.remember !== 'function' || typeof memoryModule.recall !== 'function') {
          logger.warn('Canonical memory module missing required exports', {
            event: 'brain_canonical_exports_missing',
          });
          return null;
        }
        return {
          remember: memoryModule.remember,
          recall: memoryModule.recall,
        };
      } catch (error) {
        logger.warn('Canonical memory module unavailable; using legacy brain path', {
          event: 'brain_canonical_module_unavailable',
          error: error instanceof Error ? error.message : String(error),
        });
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

export function createRuntimeBrainService(stateService: StateService): BrainService {
  const legacyBrain = createLegacyBrainService(stateService);

  return {
    async remember(avatarId: string, fact: string, about?: string, userId?: string) {
      const writeMode = readWriteMode();

      if (writeMode === 'legacy') {
        return legacyBrain.remember(avatarId, fact, about, userId);
      }

      const canonicalModule = await loadCanonicalMemoryModule();

      if (writeMode === 'canonical') {
        if (!canonicalModule) {
          throw new Error('BRAIN_WRITE_MODE=canonical requires canonical memory module availability');
        }

        await canonicalModule.remember(avatarId, fact, about, userId);
        return {
          saved: true,
          source: 'canonical' as const,
          canonicalSaved: true,
        };
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
          logger.warn('Dual-write canonical remember failed', {
            event: 'brain_dual_write_canonical_error',
            avatarId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return {
        saved: legacySaved || canonicalSaved,
        source: 'dual' as const,
        legacySaved,
        canonicalSaved,
      };
    },

    async recall(avatarId: string, query: string, userId?: string) {
      const readMode = readReadMode();
      if (readMode === 'legacy') {
        return legacyBrain.recall(avatarId, query, userId);
      }

      const canonicalModule = await loadCanonicalMemoryModule();

      if (readMode === 'canonical') {
        if (!canonicalModule) {
          throw new Error('BRAIN_READ_MODE=canonical requires canonical memory module availability');
        }
        const result = await canonicalModule.recall(avatarId, query, userId);
        return {
          source: 'canonical' as const,
          facts: result.facts.map((item) => ({
            ...item,
            userId,
            source: 'canonical' as const,
          })),
        };
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
        const legacyResult = await legacyBrain.recall(avatarId, query, userId);
        mergedFacts.push(...legacyResult.facts.map((item) => ({
          ...item,
          source: 'legacy' as const,
        })));
      }

      return {
        source: 'hybrid' as const,
        facts: dedupeFacts(mergedFacts),
      };
    },
  };
}
