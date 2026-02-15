/**
 * MCP Server Tests
 *
 * Tests for MCP server integration, request handling, and tool execution.
 */
import { describe, it, expect } from 'bun:test';
import { z } from 'zod';
import { createMCPServer } from './server.js';
import { ToolRegistry, defineTool } from './registry.js';

function createTestRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(defineTool({
    name: 'echo',
    description: 'Echo input',
    inputSchema: z.object({
      message: z.string(),
    }),
    execute: async (input) => ({
      success: true,
      data: { echo: input.message },
    }),
  }));

  registry.register(defineTool({
    name: 'add',
    description: 'Add two numbers',
    inputSchema: z.object({
      a: z.number(),
      b: z.number(),
    }),
    execute: async (input) => ({
      success: true,
      data: { result: input.a + input.b },
    }),
  }));

  registry.register(defineTool({
    name: 'failing_tool',
    description: 'Always fails',
    inputSchema: z.object({}),
    execute: async () => ({
      success: false,
      error: 'This tool always fails',
    }),
  }));

  return registry;
}

describe('MCP Server Creation', () => {
  it('creates a server with default options', () => {
    const registry = createTestRegistry();
    const server = createMCPServer({
      registry,
      defaultContext: {
        platform: 'admin-ui',
      },
      resolveAvatarId: () => 'test-avatar',
    });

    expect(server).toBeDefined();
  });

  it('creates a server with custom name and version', () => {
    const registry = createTestRegistry();
    const server = createMCPServer({
      name: 'custom-server',
      version: '2.0.0',
      registry,
      defaultContext: {
        platform: 'admin-ui',
      },
      resolveAvatarId: () => 'test-avatar',
    });

    expect(server).toBeDefined();
  });
});

describe('MCP Server - Tool Listing', () => {
  it('lists available tools in MCP format', () => {
    const registry = createTestRegistry();
    const tools = registry.toMCPFormat();

    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0]).toHaveProperty('name');
    expect(tools[0]).toHaveProperty('description');
    expect(tools[0]).toHaveProperty('inputSchema');
  });

  it('includes tool metadata when requested', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'test_tool',
      description: 'Test',
      category: 'media',
      toolset: 'media',
      tags: ['image', 'generation'],
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }));

    const tools = registry.toMCPFormatWithMetadata();

    expect(tools[0]).toHaveProperty('metadata');
    expect(tools[0].metadata).toHaveProperty('toolset', 'media');
    expect(tools[0].metadata).toHaveProperty('tags');
    expect(tools[0].metadata.tags).toContain('image');
  });

  it('generates valid JSON schemas for all tools', () => {
    const registry = createTestRegistry();
    const tools = registry.toMCPFormat();

    for (const tool of tools) {
      expect(tool.inputSchema).toHaveProperty('type');
      expect(tool.inputSchema.type).toBe('object');
    }
  });
});

describe('MCP Server - Tool Execution', () => {
  it('executes tools successfully with valid input', async () => {
    const registry = createTestRegistry();

    const result = await registry.execute('echo', { message: 'hello' }, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ echo: 'hello' });
  });

  it('executes tools with numeric inputs', async () => {
    const registry = createTestRegistry();

    const result = await registry.execute('add', { a: 5, b: 3 }, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ result: 8 });
  });

  it('handles tool execution failures gracefully', async () => {
    const registry = createTestRegistry();

    const result = await registry.execute('failing_tool', {}, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('This tool always fails');
  });

  it('validates input before execution', async () => {
    const registry = createTestRegistry();

    const result = await registry.execute('add', { a: 'not-a-number', b: 3 }, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Validation error');
  });

  it('returns error for unknown tools', async () => {
    const registry = createTestRegistry();

    const result = await registry.execute('unknown_tool', {}, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Unknown tool: unknown_tool');
  });
});

describe('MCP Server - Context Handling', () => {
  it('passes context to tool execution', async () => {
    const registry = new ToolRegistry();
    let receivedContext: any;

    registry.register(defineTool({
      name: 'context_test',
      description: 'Test context',
      inputSchema: z.object({}),
      execute: async (_input, context) => {
        receivedContext = context;
        return { success: true };
      },
    }));

    await registry.execute('context_test', {}, {
      avatarId: 'test-avatar',
      platform: 'telegram',
      userId: 'user123',
      conversationId: 'chat456',
    });

    expect(receivedContext.avatarId).toBe('test-avatar');
    expect(receivedContext.platform).toBe('telegram');
    expect(receivedContext.userId).toBe('user123');
    expect(receivedContext.conversationId).toBe('chat456');
  });

  it('includes session data in context', async () => {
    const registry = new ToolRegistry();
    let receivedContext: any;

    registry.register(defineTool({
      name: 'session_test',
      description: 'Test session',
      inputSchema: z.object({}),
      execute: async (_input, context) => {
        receivedContext = context;
        return { success: true };
      },
    }));

    await registry.execute('session_test', {}, {
      avatarId: 'test',
      platform: 'admin-ui',
      session: {
        email: 'user@example.com',
        isAdmin: true,
      },
    });

    expect(receivedContext.session?.email).toBe('user@example.com');
    expect(receivedContext.session?.isAdmin).toBe(true);
  });
});

describe('MCP Server - Response Formats', () => {
  it('handles media responses', async () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'media_tool',
      description: 'Returns media',
      inputSchema: z.object({}),
      execute: async () => ({
        success: true,
        data: { id: '123' },
        media: {
          type: 'image' as const,
          url: 'https://example.com/image.jpg',
          caption: 'Test image',
        },
      }),
    }));

    const result = await registry.execute('media_tool', {}, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(true);
    expect(result.media).toBeDefined();
    expect(result.media?.type).toBe('image');
    expect(result.media?.url).toBe('https://example.com/image.jpg');
  });

  it('handles pending job responses', async () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'async_tool',
      description: 'Returns pending job',
      inputSchema: z.object({}),
      execute: async () => ({
        success: true,
        pendingJob: {
          jobId: 'job-123',
          type: 'video' as const,
          status: 'pending',
        },
      }),
    }));

    const result = await registry.execute('async_tool', {}, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(true);
    expect(result.pendingJob).toBeDefined();
    expect(result.pendingJob?.jobId).toBe('job-123');
    expect(result.pendingJob?.type).toBe('video');
  });

  it('handles UI action responses', async () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'ui_tool',
      description: 'Returns UI action',
      inputSchema: z.object({}),
      execute: async () => ({
        success: true,
        uiAction: {
          type: 'upload_widget' as const,
          payload: { mode: 'image' },
        },
      }),
    }));

    const result = await registry.execute('ui_tool', {}, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(true);
    expect(result.uiAction).toBeDefined();
    expect(result.uiAction?.type).toBe('upload_widget');
  });
});

describe('MCP Server - Error Handling', () => {
  it('catches and formats execution errors', async () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'error_tool',
      description: 'Throws error',
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error('Something went wrong');
      },
    }));

    const result = await registry.execute('error_tool', {}, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Something went wrong');
  });

  it('handles non-Error exceptions', async () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'throw_string',
      description: 'Throws string',
      inputSchema: z.object({}),
      execute: async () => {
        throw 'String error';
      },
    }));

    const result = await registry.execute('throw_string', {}, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Unknown error');
  });
});
