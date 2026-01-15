/**
 * Core Constants
 * Centralized configuration values used across the swarm
 */

/**
 * Default LLM model for new agents and fallback scenarios.
 * Each agent stores their own model in llmConfig.model - this is just the default.
 */
export const DEFAULT_LLM_MODEL = 'anthropic/claude-3-5-haiku-20241022';

/**
 * Default LLM provider
 */
export const DEFAULT_LLM_PROVIDER = 'openrouter';

/**
 * Default LLM temperature
 */
export const DEFAULT_LLM_TEMPERATURE = 0.8;

/**
 * Default max tokens
 */
export const DEFAULT_LLM_MAX_TOKENS = 1024;
