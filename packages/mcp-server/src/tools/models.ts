/**
 * Model Configuration Tools
 *
 * Simplified tools for managing LLM models with automatic fallback support.
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number;
  pricing?: {
    prompt: number | string;
    completion: number | string;
  };
}

export interface ModelServices {
  listModels: (family?: string) => Promise<ModelInfo[]>;

  getConfig: (avatarId: string) => Promise<{
    model: string;
    temperature: number;
    maxTokens: number;
    provider?: string;
  }>;

  updateConfig: (
    avatarId: string,
    config: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
    }
  ) => Promise<void>;

  /** Get fallback chain for a model */
  getFallbacks?: (model: string) => string[];
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createModelTools = (services: ModelServices) => [
  /**
   * Combined tool: Get current model config OR list available models
   * Simplifies the interface - one tool for reading model info
   */
  defineTool({
    name: 'get_model_info',
    description:
      'Get my current model configuration, or list available models. ' +
      'If no action specified, returns current config with fallback chain.',
    category: 'config',
    toolset: 'models',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({
      action: z
        .enum(['current', 'list'])
        .optional()
        .default('current')
        .describe('"current" = my config, "list" = available models'),
      family: z
        .string()
        .optional()
        .describe('For "list": filter by family (claude, gpt, deepseek, gemini)'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      if (input.action === 'list') {
        const models = await services.listModels(input.family);
        return {
          success: true,
          data: {
            models: models.slice(0, 15).map((m) => ({
              id: m.id,
              name: m.name,
              context: m.contextLength,
            })),
            hint: 'Use set_model to change your model',
          },
        };
      }

      // Default: get current config
      const config = await services.getConfig(context.avatarId);
      const fallbacks = services.getFallbacks?.(config.model) ?? [];

      return {
        success: true,
        data: {
          model: config.model,
          temperature: config.temperature,
          maxTokens: config.maxTokens,
          fallbacks: fallbacks.length > 0 ? fallbacks : undefined,
          note: fallbacks.length > 0
            ? `If ${config.model} fails, will auto-fallback to: ${fallbacks.join(' → ')}`
            : 'No fallback chain configured',
        },
      };
    },
  }),

  /**
   * Set model - combines change_my_model functionality with better feedback
   */
  defineTool({
    name: 'set_model',
    description:
      'Change my AI model. Includes automatic fallback - if the model fails, ' +
      'the system will try backup models automatically.',
    category: 'config',
    toolset: 'models',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({
      model: z
        .string()
        .describe(
          'Model ID (e.g., "anthropic/claude-sonnet-4", "openai/gpt-4o", "deepseek/deepseek-r1")'
        ),
      temperature: z
        .number()
        .min(0)
        .max(2)
        .optional()
        .describe('Creativity: 0=precise, 1=balanced, 2=creative (default 0.8)'),
      maxTokens: z
        .number()
        .min(100)
        .max(32000)
        .optional()
        .describe('Max response length (default 1024)'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      await services.updateConfig(context.avatarId, {
        model: input.model,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
      });

      const fallbacks = services.getFallbacks?.(input.model) ?? [];

      return {
        success: true,
        data: {
          message: `Model set to ${input.model}`,
          model: input.model,
          temperature: input.temperature ?? 0.8,
          maxTokens: input.maxTokens ?? 1024,
          fallbacks: fallbacks.length > 0 ? fallbacks : undefined,
          note: fallbacks.length > 0
            ? `Fallback chain: ${input.model} → ${fallbacks.join(' → ')}`
            : undefined,
        },
      };
    },
  }),
];

export default createModelTools;
