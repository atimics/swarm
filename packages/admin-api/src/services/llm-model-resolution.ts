/**
 * LLM Model Resolution Service
 *
 * Handles model selection with automatic fallback on errors.
 */
import { logger } from '@swarm/core';
import {
  getModelChain,
  isFallbackTriggerError,
  getFallbackModels,
} from './models-registry.js';

export function normalizeModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveChatModel(params: {
  requestModel: unknown;
  avatarModel: unknown;
  defaultModel: string;
}): string {
  return (
    normalizeModel(params.requestModel) ??
    normalizeModel(params.avatarModel) ??
    params.defaultModel
  );
}

// ============================================================================
// FALLBACK EXECUTION
// ============================================================================

export interface ModelExecutionResult<T> {
  result: T;
  model: string;
  attemptedModels: string[];
  usedFallback: boolean;
}

export interface ModelExecutionOptions {
  /** Primary model to use */
  primaryModel: string;
  /** Avatar ID for logging */
  avatarId?: string;
  /** Maximum number of fallback attempts (default: 2) */
  maxFallbackAttempts?: number;
}

/**
 * Execute an LLM operation with automatic fallback on errors.
 *
 * @param execute - Function that executes the LLM call with a given model
 * @param options - Configuration options
 * @returns Result with metadata about which model was used
 *
 * @example
 * ```typescript
 * const { result, model, usedFallback } = await executeWithFallback(
 *   async (model) => await callLLM(model, prompt),
 *   { primaryModel: 'anthropic/claude-3-5-sonnet-latest' }
 * );
 * ```
 */
export async function executeWithFallback<T>(
  execute: (model: string) => Promise<T>,
  options: ModelExecutionOptions
): Promise<ModelExecutionResult<T>> {
  const {
    primaryModel,
    avatarId = 'unknown',
    maxFallbackAttempts = 2,
  } = options;

  const modelChain = getModelChain(primaryModel);
  const modelsToTry = modelChain.slice(0, 1 + maxFallbackAttempts);
  const attemptedModels: string[] = [];
  let lastError: Error | undefined;

  for (let i = 0; i < modelsToTry.length; i++) {
    const model = modelsToTry[i];
    attemptedModels.push(model);

    try {
      const result = await execute(model);

      // Log if we used a fallback
      if (i > 0) {
        logger.info('LLM fallback succeeded', {
          event: 'llm_fallback_success',
          avatarId,
          primaryModel,
          fallbackModel: model,
          attemptNumber: i + 1,
          attemptedModels,
        });
      }

      return {
        result,
        model,
        attemptedModels,
        usedFallback: i > 0,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if this error should trigger fallback
      if (!isFallbackTriggerError(error)) {
        // Non-fallback error - rethrow immediately
        logger.warn('LLM error (not retrying with fallback)', {
          event: 'llm_error_no_fallback',
          avatarId,
          model,
          error: lastError.message,
        });
        throw error;
      }

      // Log the fallback trigger
      logger.warn('LLM error triggering fallback', {
        event: 'llm_fallback_triggered',
        avatarId,
        failedModel: model,
        error: lastError.message,
        nextModel: modelsToTry[i + 1] ?? 'none',
        attemptNumber: i + 1,
      });
    }
  }

  // All models failed
  logger.error('All LLM fallback models exhausted', {
    event: 'llm_fallback_exhausted',
    avatarId,
    primaryModel,
    attemptedModels,
    lastError: lastError?.message,
  });

  throw lastError ?? new Error('All fallback models failed');
}

/**
 * Get info about the fallback chain for a model (for UI display)
 */
export function getFallbackInfo(model: string): {
  primary: string;
  fallbacks: string[];
  totalOptions: number;
} {
  const fallbacks = getFallbackModels(model);
  return {
    primary: model,
    fallbacks,
    totalOptions: 1 + fallbacks.length,
  };
}
