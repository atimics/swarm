/**
 * Prompt Preview Handler
 *
 * Returns a preview of what would be sent to the LLM for a given agent context.
 * Useful for debugging and understanding agent behavior.
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { authenticateRequest } from '../auth/cloudflare-access.js';
import { buildDynamicSystemPrompt, type ToolCategory } from '../services/dynamic-prompts.js';
import {
  ToolRegistry,
  registerAllTools,
  type ToolContext,
  type ToolsetId,
} from '@swarm/mcp-server';
import { createMCPServices } from '../services/mcp-adapter.js';
import * as agents from '../services/agents.js';
import { getEnabledToolsets } from '../services/mcp-config.js';

const PreviewRequestSchema = z.object({
  agentId: z.string(),
  message: z.string().optional(),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system', 'tool']),
    content: z.string(),
  })).optional(),
});

interface ToolPreview {
  name: string;
  description: string;
  toolset: string;
  parameters: Record<string, unknown>;
}

interface PromptPreviewResponse {
  systemPrompt: string;
  tools: ToolPreview[];
  toolCount: number;
  enabledToolsets: string[];
  enabledCategories: string[];
  messages: Array<{
    role: string;
    content: string;
  }>;
  tokenEstimate: {
    systemPrompt: number;
    tools: number;
    messages: number;
    total: number;
  };
}

const CATEGORY_TOOLSETS: Record<ToolCategory, ToolsetId[]> = {
  secrets: ['secrets'],
  wallets: ['wallet'],
  profile: ['profile'],
  media: ['media'],
  gallery: ['gallery'],
  voice: ['voice'],
  telegram: ['telegram'],
  twitter: ['twitter'],
  discord: ['discord'],
  memory: ['memory'],
  nft: ['nft'],
  property: ['property'],
  diagnostics: ['diagnostics'],
};

function resolveAllowedToolsets(categories?: ToolCategory[]): ToolsetId[] {
  const toolsets = new Set<ToolsetId>(['core', 'admin', 'config', 'jobs', 'models']);

  if (categories) {
    for (const category of categories) {
      const mapped = CATEGORY_TOOLSETS[category] || [];
      for (const toolset of mapped) {
        toolsets.add(toolset);
      }
    }
  }

  return Array.from(toolsets);
}

// Rough token estimation (4 chars per token is a common approximation)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  // CORS preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, CF-Access-Client-Id, CF-Access-Client-Secret',
        'Access-Control-Allow-Credentials': 'true',
      },
      body: '',
    };
  }

  try {
    // Authenticate
    const session = await authenticateRequest(event);

    // Parse request
    if (!event.body) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Request body required' }),
      };
    }

    const parsed = PreviewRequestSchema.safeParse(JSON.parse(event.body));
    if (!parsed.success) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid request', details: parsed.error.errors }),
      };
    }

    const { agentId, message, history = [] } = parsed.data;

    // Get agent config
    const agentRecord = await agents.getAgent(agentId);
    if (!agentRecord) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Agent not found' }),
      };
    }

    // Determine enabled categories based on agent configuration
    const enabledCategories: ToolCategory[] = [
      'secrets', 'profile', 'media', 'gallery', 'wallets', 'diagnostics'
    ];
    if (agentRecord.voiceConfig?.enabled) enabledCategories.push('voice');
    if (agentRecord.platforms?.telegram?.enabled) enabledCategories.push('telegram');
    if (agentRecord.platforms?.twitter?.enabled) enabledCategories.push('twitter');
    if (agentRecord.platforms?.discord?.enabled) enabledCategories.push('discord');
    // memory, nft, property are opt-in
    enabledCategories.push('memory', 'nft', 'property');

    // Build system prompt
    const systemPrompt = buildDynamicSystemPrompt({
      id: agentId,
      name: agentRecord.name,
      description: agentRecord.description,
      persona: agentRecord.persona,
      enabledCategories,
      platform: 'admin-ui',
    });

    // Get enabled toolsets from MCP config (or defaults if not configured)
    const mcpEnabledToolsets = await getEnabledToolsets(agentId);
    const categoryToolsets = resolveAllowedToolsets(enabledCategories);

    // Merge: use MCP enabled toolsets if configured, otherwise use category-based defaults
    const effectiveToolsets = mcpEnabledToolsets.length > 1
      ? mcpEnabledToolsets
      : categoryToolsets;

    // Build tool registry
    const mcpServices = createMCPServices(agentId, session);
    const toolRegistry = new ToolRegistry();
    registerAllTools(toolRegistry, mcpServices);

    const toolContext: ToolContext = {
      agentId,
      platform: 'admin-ui',
      session: {
        email: session.email,
        isAdmin: session.isAdmin,
      },
    };

    // Get tools filtered by platform and toolsets
    const allTools = toolRegistry.getForPlatform(toolContext.platform);
    const filteredTools = allTools.filter(tool =>
      effectiveToolsets.includes(tool.toolset || 'core')
    );

    // Build tool previews
    const toolPreviews: ToolPreview[] = await Promise.all(
      filteredTools.map(async (tool) => {
        let description = tool.description;
        if (tool.contextBuilder) {
          try {
            const contextStr = await tool.contextBuilder(toolContext);
            if (contextStr) {
              description = `${description}\n\n📌 ${contextStr}`;
            }
          } catch {
            // Ignore context builder errors in preview
          }
        }

        return {
          name: tool.name,
          description,
          toolset: tool.toolset || 'core',
          parameters: zodToJsonSchema(tool.inputSchema, { target: 'openApi3' }) as Record<string, unknown>,
        };
      })
    );

    // Build message preview
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
    ];
    if (message) {
      messages.push({ role: 'user', content: message });
    }

    // Estimate tokens
    const toolsJson = JSON.stringify(toolPreviews);
    const messagesText = messages.map(m => m.content).join('\n');

    const tokenEstimate = {
      systemPrompt: estimateTokens(systemPrompt),
      tools: estimateTokens(toolsJson),
      messages: estimateTokens(messagesText) - estimateTokens(systemPrompt), // Don't double count system
      total: 0,
    };
    tokenEstimate.total = tokenEstimate.systemPrompt + tokenEstimate.tools + tokenEstimate.messages;

    const response: PromptPreviewResponse = {
      systemPrompt,
      tools: toolPreviews,
      toolCount: toolPreviews.length,
      enabledToolsets: effectiveToolsets,
      enabledCategories,
      messages,
      tokenEstimate,
    };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': 'true',
      },
      body: JSON.stringify(response),
    };
  } catch (error) {
    console.error('Prompt preview error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
}
