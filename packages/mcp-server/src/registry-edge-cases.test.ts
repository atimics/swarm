/**
 * Registry Edge Cases Tests
 *
 * Tests for edge cases, error handling, and advanced registry features.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, defineTool, defineReadonlyTool, defineManualTool } from './registry.js';

describe('Registry - Tool Registration', () => {
  it('allows registering a new tool', () => {
    const registry = new ToolRegistry();
    const tool = defineTool({
      name: 'test_tool',
      description: 'Test',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    });

    registry.register(tool);

    expect(registry.get('test_tool')).toBeDefined();
  });

  it('warns when overwriting existing tool', () => {
    const registry = new ToolRegistry();
    const tool1 = defineTool({
      name: 'same_name',
      description: 'First',
      inputSchema: z.object({}),
      execute: async () => ({ success: true, data: { version: 1 } }),
    });
    const tool2 = defineTool({
      name: 'same_name',
      description: 'Second',
      inputSchema: z.object({}),
      execute: async () => ({ success: true, data: { version: 2 } }),
    });

    registry.register(tool1);
    registry.register(tool2);

    const result = registry.get('same_name');
    expect(result?.description).toBe('Second');
  });

  it('registers multiple tools at once', () => {
    const registry = new ToolRegistry();
    const tools = [
      defineTool({
        name: 'tool1',
        description: 'First',
        inputSchema: z.object({}),
        execute: async () => ({ success: true }),
      }),
      defineTool({
        name: 'tool2',
        description: 'Second',
        inputSchema: z.object({}),
        execute: async () => ({ success: true }),
      }),
    ];

    registry.registerAll(tools);

    expect(registry.get('tool1')).toBeDefined();
    expect(registry.get('tool2')).toBeDefined();
  });
});

describe('Registry - Tool Retrieval', () => {
  it('returns undefined for non-existent tools', () => {
    const registry = new ToolRegistry();

    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('retrieves all registered tools', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'tool1',
      description: 'First',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }));
    registry.register(defineTool({
      name: 'tool2',
      description: 'Second',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }));

    const all = registry.getAll();
    expect(all.length).toBe(2);
  });

  it('filters tools by category', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'media_tool',
      description: 'Media',
      category: 'media',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }));
    registry.register(defineTool({
      name: 'wallet_tool',
      description: 'Wallet',
      category: 'wallet',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }));

    const mediaTools = registry.getByCategory('media');
    expect(mediaTools.length).toBe(1);
    expect(mediaTools[0].name).toBe('media_tool');
  });
});

describe('Registry - Platform Filtering', () => {
  it('includes platform-specific tools only on matching platforms', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'admin_only',
      description: 'Admin',
      platforms: ['admin-ui'],
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }));
    registry.register(defineTool({
      name: 'telegram_only',
      description: 'Telegram',
      platforms: ['telegram'],
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }));

    const adminTools = registry.getForPlatform('admin-ui');
    const telegramTools = registry.getForPlatform('telegram');

    expect(adminTools.some(t => t.name === 'admin_only')).toBe(true);
    expect(adminTools.some(t => t.name === 'telegram_only')).toBe(false);
    expect(telegramTools.some(t => t.name === 'telegram_only')).toBe(true);
  });

  it('includes tools without platform restrictions everywhere', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'universal',
      description: 'Universal',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }));

    const adminTools = registry.getForPlatform('admin-ui');
    const telegramTools = registry.getForPlatform('telegram');

    expect(adminTools.some(t => t.name === 'universal')).toBe(true);
    expect(telegramTools.some(t => t.name === 'universal')).toBe(true);
  });
});

describe('Registry - Conditional Visibility', () => {
  it('supports shouldShow predicate for dynamic visibility', async () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'conditional_tool',
      description: 'Conditional',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
      shouldShow: async (context) => context.avatarId === 'allowed',
    }));

    const tool = registry.get('conditional_tool');
    expect(tool?.shouldShow).toBeDefined();

    const showForAllowed = await tool!.shouldShow!({
      avatarId: 'allowed',
      platform: 'admin-ui',
    });
    const hideForOthers = await tool!.shouldShow!({
      avatarId: 'other',
      platform: 'admin-ui',
    });

    expect(showForAllowed).toBe(true);
    expect(hideForOthers).toBe(false);
  });
});

describe('Registry - Tool Helpers', () => {
  it('defineTool creates valid tool definition', () => {
    const tool = defineTool({
      name: 'helper_tool',
      description: 'Test',
      inputSchema: z.object({ value: z.string() }),
      execute: async () => ({ success: true }),
    });

    expect(tool.name).toBe('helper_tool');
    expect(tool.inputSchema).toBeDefined();
    expect(tool.execute).toBeDefined();
  });

  it('defineReadonlyTool sets readonly category', () => {
    const tool = defineReadonlyTool({
      name: 'read_tool',
      description: 'Read',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    });

    expect(tool.category).toBe('readonly');
  });

  it('defineManualTool sets execute to false', () => {
    const tool = defineManualTool({
      name: 'manual_tool',
      description: 'Manual',
      inputSchema: z.object({}),
    });

    expect(tool.execute).toBe(false);
    expect(tool.category).toBe('config');
  });
});

describe('Registry - Output Validation', () => {
  it('validates output against outputSchema when provided', async () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'validated_output',
      description: 'Test',
      inputSchema: z.object({}),
      outputSchema: z.object({
        result: z.number(),
      }),
      execute: async () => ({
        success: true,
        data: { result: 42 },
      }),
    }));

    const result = await registry.execute('validated_output', {}, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ result: 42 });
  });
});

describe('Registry - Error Handling', () => {
  it('catches synchronous errors in tool execution', async () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'sync_error',
      description: 'Sync error',
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error('Sync error occurred');
      },
    }));

    const result = await registry.execute('sync_error', {}, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Sync error occurred');
  });

  it('handles tools that return error results', async () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'error_result',
      description: 'Error',
      inputSchema: z.object({}),
      execute: async () => ({
        success: false,
        error: 'Tool-level error',
      }),
    }));

    const result = await registry.execute('error_result', {}, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Tool-level error');
  });
});

describe('Registry - Toolset Normalization', () => {
  it('derives toolset from category when not specified', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'media_cat',
      description: 'Media',
      category: 'media',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }));

    const tool = registry.get('media_cat');
    expect(tool?.toolset).toBe('media');
  });

  it('defaults to core toolset when no category', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'no_category',
      description: 'No category',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }));

    const tool = registry.get('no_category');
    expect(tool?.toolset).toBe('core');
  });

  it('assigns default tags based on toolset', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'auto_tags',
      description: 'Auto tags',
      toolset: 'media',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }));

    const tool = registry.get('auto_tags');
    expect(tool?.tags).toBeDefined();
    expect(tool?.tags?.length).toBeGreaterThan(0);
  });
});

describe('Registry - Context Builder', () => {
  it('enriches tool descriptions with context', async () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'context_tool',
      description: 'Base description',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
      contextBuilder: async (context) => `Current avatar: ${context.avatarId}`,
    }));

    const tools = await registry.toOpenAIFormatWithContext({
      avatarId: 'test-123',
      platform: 'admin-ui',
    });

    const tool = tools.find(t => t.function.name === 'context_tool');
    expect(tool?.function.description).toContain('Base description');
    expect(tool?.function.description).toContain('Current avatar: test-123');
  });

  it('handles undefined context gracefully', async () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'no_context',
      description: 'Description',
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
      contextBuilder: async () => undefined,
    }));

    const tools = await registry.toOpenAIFormatWithContext({
      avatarId: 'test',
      platform: 'admin-ui',
    });

    const tool = tools.find(t => t.function.name === 'no_context');
    expect(tool?.function.description).toBe('Description');
  });
});
