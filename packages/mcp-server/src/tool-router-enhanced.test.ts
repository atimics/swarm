/**
 * Enhanced Tool Router Tests
 *
 * Additional tests for tool routing logic, keyword matching, and filtering.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { routeTools } from './tool-router.js';
import { defineTool, type ToolDefinition } from './registry.js';

function createMockTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'send_message',
      description: 'Send message',
      toolset: 'core',
      tags: [],
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }),
    defineTool({
      name: 'generate_image',
      description: 'Generate image',
      toolset: 'media',
      tags: ['image', 'generation'],
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }),
    defineTool({
      name: 'generate_video',
      description: 'Generate video',
      toolset: 'media',
      tags: ['video', 'generation'],
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }),
    defineTool({
      name: 'get_wallet_balance',
      description: 'Get wallet balance',
      toolset: 'wallet',
      tags: ['wallet', 'balance'],
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }),
    defineTool({
      name: 'create_wallet',
      description: 'Create wallet',
      toolset: 'wallet',
      tags: ['wallet'],
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }),
    defineTool({
      name: 'twitter_post',
      description: 'Post tweet',
      toolset: 'twitter',
      tags: ['twitter', 'post'],
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }),
    defineTool({
      name: 'search_property',
      description: 'Search property',
      toolset: 'property',
      tags: ['property', 'real estate'],
      inputSchema: z.object({}),
      execute: async () => ({ success: true }),
    }),
  ];
}

describe('Tool Router - Keyword Matching', () => {
  it('selects media toolset for image keywords', () => {
    const tools = createMockTools();
    const result = routeTools(tools, { text: 'generate an image of a cat' });

    expect(result.toolsets).toContain('media');
    expect(result.tools.some(t => t.name === 'generate_image')).toBe(true);
  });

  it('selects media toolset for video keywords', () => {
    const tools = createMockTools();
    const result = routeTools(tools, { text: 'create a video' });

    expect(result.toolsets).toContain('media');
    expect(result.tools.some(t => t.name === 'generate_video')).toBe(true);
  });

  it('selects wallet toolset for balance keywords', () => {
    const tools = createMockTools();
    const result = routeTools(tools, { text: 'check my wallet balance' });

    expect(result.toolsets).toContain('wallet');
    expect(result.tools.some(t => t.name === 'get_wallet_balance')).toBe(true);
  });

  it('selects twitter toolset for tweet keywords', () => {
    const tools = createMockTools();
    const result = routeTools(tools, { text: 'post a tweet about AI' });

    expect(result.toolsets).toContain('twitter');
    expect(result.tools.some(t => t.name === 'twitter_post')).toBe(true);
  });

  it('selects property toolset for real estate keywords', () => {
    const tools = createMockTools();
    const result = routeTools(tools, { text: 'search for property listings' });

    expect(result.toolsets).toContain('property');
    expect(result.tools.some(t => t.name === 'search_property')).toBe(true);
  });
});

describe('Tool Router - Multiple Toolsets', () => {
  it('selects multiple toolsets for complex queries', () => {
    const tools = createMockTools();
    const result = routeTools(tools, {
      text: 'generate an image and post it to twitter',
    });

    expect(result.toolsets.length).toBeGreaterThan(1);
    expect(result.toolsets).toContain('media');
    expect(result.toolsets).toContain('twitter');
  });

  it('respects maxToolsets limit', () => {
    const tools = createMockTools();
    const result = routeTools(tools, {
      text: 'image video wallet twitter property',
      maxToolsets: 2,
    });

    expect(result.toolsets.length).toBeLessThanOrEqual(2);
  });

  it('always includes core toolset', () => {
    const tools = createMockTools();
    const result = routeTools(tools, { text: 'generate image' });

    expect(result.toolsets).toContain('core');
  });
});

describe('Tool Router - Include/Exclude Filters', () => {
  it('includes specified toolsets', () => {
    const tools = createMockTools();
    const result = routeTools(tools, {
      text: '',
      includeToolsets: ['wallet', 'media'],
    });

    expect(result.toolsets).toContain('wallet');
    expect(result.toolsets).toContain('media');
  });

  it('excludes specified toolsets', () => {
    const tools = createMockTools();
    const result = routeTools(tools, {
      text: 'wallet balance',
      excludeToolsets: ['wallet'],
    });

    expect(result.toolsets).not.toContain('wallet');
  });

  it('include takes precedence over keyword scoring', () => {
    const tools = createMockTools();
    const result = routeTools(tools, {
      text: 'generate image',
      includeToolsets: ['property'],
      maxToolsets: 3,
    });

    expect(result.toolsets).toContain('property');
  });
});

describe('Tool Router - Scoring', () => {
  it('returns scores for all toolsets', () => {
    const tools = createMockTools();
    const result = routeTools(tools, { text: 'wallet image' });

    expect(result.scores).toBeDefined();
    expect(typeof result.scores.wallet).toBe('number');
    expect(typeof result.scores.media).toBe('number');
  });

  it('scores higher for multiple keyword matches', () => {
    const tools = createMockTools();
    const result = routeTools(tools, { text: 'wallet balance solana' });

    expect(result.scores.wallet).toBeGreaterThan(0);
  });

  it('scores zero for non-matching text', () => {
    const tools = createMockTools();
    const result = routeTools(tools, { text: 'unrelated text' });

    // Most toolsets should have zero or very low scores
    expect(result.scores.wallet).toBe(0);
    expect(result.scores.media).toBe(0);
  });
});

describe('Tool Router - Default Behavior', () => {
  it('uses default maxToolsets of 3', () => {
    const tools = createMockTools();
    const result = routeTools(tools, { text: '' });

    expect(result.toolsets.length).toBeLessThanOrEqual(3);
  });

  it('falls back to priority order when no text', () => {
    const tools = createMockTools();
    const result = routeTools(tools, { text: '' });

    expect(result.toolsets).toContain('core');
    expect(result.toolsets.length).toBeGreaterThan(0);
  });

  it('handles empty tools array', () => {
    const result = routeTools([], { text: 'test' });

    expect(result.toolsets).toEqual([]);
    expect(result.tools).toEqual([]);
  });
});

describe('Tool Router - Tag Matching', () => {
  it('matches tool tags in addition to toolset keywords', () => {
    const tools = createMockTools();
    const result = routeTools(tools, { text: 'generation' });

    // 'generation' is a tag on media tools
    expect(result.toolsets).toContain('media');
  });

  it('combines toolset keywords and tool tags for scoring', () => {
    const tools = createMockTools();
    const mediaResult = routeTools(tools, { text: 'image generation' });

    expect(mediaResult.scores.media).toBeGreaterThan(0);
  });
});

describe('Tool Router - Tool Filtering', () => {
  it('only returns tools from selected toolsets (plus core)', () => {
    const tools = createMockTools();
    const result = routeTools(tools, {
      text: '',
      includeToolsets: ['wallet'],
      maxToolsets: 2,
    });

    const toolsets = new Set(result.tools.map(t => t.toolset || 'core'));
    // Should include wallet and core (core is always included)
    expect(toolsets.has('wallet')).toBe(true);
    expect(toolsets.has('core')).toBe(true);
  });

  it('includes all tools from selected toolsets', () => {
    const tools = createMockTools();
    const result = routeTools(tools, {
      text: 'wallet',
      maxToolsets: 2,
    });

    const walletTools = result.tools.filter(t => t.toolset === 'wallet');
    expect(walletTools.length).toBe(2); // get_wallet_balance and create_wallet
  });
});
