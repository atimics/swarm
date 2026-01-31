/**
 * OpenAI-Compatible Chat Completions API
 *
 * Provides a public API endpoint compatible with the OpenAI /v1/chat/completions format.
 * This allows external applications to chat with any avatar using the familiar OpenAI API format.
 *
 * Authentication: API key via Authorization header (Bearer token)
 * Endpoint: POST /v1/chat/completions
 *
 * The model parameter is used to specify the avatar ID:
 *   - "avatar:{avatarId}" - e.g., "avatar:my-bot"
 *   - Just the avatarId works too - e.g., "my-bot"
 *
 * Usage:
 * ```bash
 * curl -X POST https://api.example.com/v1/chat/completions \
 *   -H "Authorization: Bearer sk-..." \
 *   -H "Content-Type: application/json" \
 *   -d '{
 *     "model": "avatar:my-bot",
 *     "messages": [{"role": "user", "content": "Hello!"}],
 *     "stream": false
 *   }'
 * ```
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z } from 'zod';
import { createHash, randomBytes } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@swarm/core';
import type { ToolCategory } from '@swarm/core';
import { processChat } from './chat.js';
import type { UserSession } from '../types.js';
import * as avatars from '../services/avatars.js';
import * as voice from '../services/voice.js';
import { getCorsHeaders } from '../http/cors.js';

// =============================================================================
// Configuration
// =============================================================================

const ADMIN_TABLE = process.env.ADMIN_TABLE!;

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

// =============================================================================
// OpenAI-Compatible Types
// =============================================================================

const OpenAIMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
  name: z.string().optional(),
});

const ChatCompletionRequestSchema = z.object({
  model: z.string(), // Will be parsed as avatar ID
  messages: z.array(OpenAIMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional().default(false),
  user: z.string().optional(), // Optional user identifier for tracking
  // Non-standard extensions for avatar features
  include_audio: z.boolean().optional().default(false), // Generate voice audio for response
});

type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

interface ChatCompletionChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string;
    audio?: {
      url: string;
      format: string;
      duration_ms?: number;
    };
  };
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter';
}

interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIError {
  error: {
    message: string;
    type: string;
    param?: string;
    code?: string;
  };
}

// =============================================================================
// API Key Authentication
// =============================================================================

interface ApiKeyRecord {
  pk: string; // API_KEY#{keyHash}
  sk: string; // 'META'
  keyPrefix: string; // First 8 chars for display (e.g., "sk-abc123...")
  keyHash: string; // SHA-256 hash of the full key
  avatarId: string; // The avatar this key grants access to, or '*' for all
  name: string; // Human-readable name for the key
  createdAt: number;
  createdBy: string; // Email or userId of creator
  lastUsedAt?: number;
  usageCount: number;
  rateLimit?: {
    requestsPerMinute: number;
    requestsPerDay: number;
  };
  enabled: boolean;
}

/**
 * Hash an API key for secure storage/lookup
 */
function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Extract API key from Authorization header
 */
function extractApiKey(event: APIGatewayProxyEventV2): string | null {
  const authHeader = event.headers['authorization'] || event.headers['Authorization'];
  if (!authHeader) return null;

  // Support both "Bearer sk-..." and just "sk-..."
  const key = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : authHeader.trim();

  // Validate format (must start with sk- or swarm-)
  if (!key.startsWith('sk-') && !key.startsWith('swarm-')) {
    return null;
  }

  return key;
}

/**
 * Validate API key and return the associated session
 */
async function validateApiKey(apiKey: string): Promise<{
  valid: boolean;
  session?: UserSession;
  avatarId?: string;
  error?: string;
}> {
  const keyHash = hashApiKey(apiKey);

  try {
    const result = await docClient.send(new GetCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `API_KEY#${keyHash}`,
        sk: 'META',
      },
    }));

    const keyRecord = result.Item as ApiKeyRecord | undefined;

    if (!keyRecord) {
      return { valid: false, error: 'Invalid API key' };
    }

    if (!keyRecord.enabled) {
      return { valid: false, error: 'API key is disabled' };
    }

    // Update last used timestamp and usage count (fire and forget)
    docClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `API_KEY#${keyHash}`,
        sk: 'META',
      },
      UpdateExpression: 'SET lastUsedAt = :now, usageCount = usageCount + :one',
      ExpressionAttributeValues: {
        ':now': Date.now(),
        ':one': 1,
      },
    })).catch(err => {
      logger.warn('Failed to update API key usage', { error: err.message });
    });

    // Create a session for the API key user
    const session: UserSession = {
      email: `api-key:${keyRecord.keyPrefix}...`,
      userId: `api-key:${keyRecord.keyHash.slice(0, 16)}`,
      isAdmin: false,
      accessToken: '',
    };

    return {
      valid: true,
      session,
      avatarId: keyRecord.avatarId === '*' ? undefined : keyRecord.avatarId,
    };
  } catch (err) {
    logger.error('API key validation error', err);
    return { valid: false, error: 'Authentication error' };
  }
}

// =============================================================================
// Avatar Resolution
// =============================================================================

/**
 * Parse the model parameter to extract avatar ID
 * Supports: "avatar:my-bot", "my-bot", etc.
 */
function parseAvatarId(model: string): string {
  // Handle "avatar:{id}" format
  if (model.startsWith('avatar:')) {
    return model.slice(7);
  }
  // Otherwise treat the whole model as the avatar ID
  return model;
}

// =============================================================================
// Response Helpers
// =============================================================================

function jsonResponse(
  statusCode: number,
  body: unknown,
  headers?: Record<string, string>
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

function errorResponse(
  statusCode: number,
  message: string,
  type: string = 'invalid_request_error',
  code?: string,
  headers?: Record<string, string>
): APIGatewayProxyResultV2 {
  const error: OpenAIError = {
    error: {
      message,
      type,
      code,
    },
  };
  return jsonResponse(statusCode, error, headers);
}

// =============================================================================
// Main Handler
// =============================================================================

/**
 * Lambda handler for OpenAI-compatible chat completions API
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const corsHeaders = getCorsHeaders(event);
  const requestId = event.requestContext.requestId;

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  const method = event.requestContext.http.method;
  const rawPath = event.rawPath || '/';
  const path = rawPath.startsWith('/v1') ? rawPath : `/v1${rawPath}`;

  logger.info('OpenAI compat request', {
    event: 'request_received',
    subsystem: 'openai-compat',
    method,
    path,
    requestId,
  });

  // GET /v1/models - List available avatars as "models"
  if (method === 'GET' && (path === '/v1/models' || path === '/models')) {
    return handleListModels(event, corsHeaders);
  }

  // GET /v1/models/{model_id} - Get specific avatar details
  const modelMatch = path.match(/^\/v1\/models\/(.+)$/) || path.match(/^\/models\/(.+)$/);
  if (method === 'GET' && modelMatch) {
    return handleGetModel(event, modelMatch[1], corsHeaders);
  }

  // POST /v1/chat/completions - Main chat endpoint
  if (method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
    return handleChatCompletions(event, corsHeaders, requestId);
  }

  return errorResponse(404, `Unknown endpoint: ${path}`, 'not_found', undefined, corsHeaders);
}

/**
 * GET /v1/models - List available avatars
 */
async function handleListModels(
  event: APIGatewayProxyEventV2,
  corsHeaders: Record<string, string>
): Promise<APIGatewayProxyResultV2> {
  // Validate API key
  const apiKey = extractApiKey(event);
  if (!apiKey) {
    return errorResponse(401, 'Missing API key', 'authentication_error', 'missing_api_key', corsHeaders);
  }

  const validation = await validateApiKey(apiKey);
  if (!validation.valid) {
    return errorResponse(401, validation.error || 'Invalid API key', 'authentication_error', 'invalid_api_key', corsHeaders);
  }

  try {
    // If API key is scoped to a specific avatar, only return that one
    if (validation.avatarId) {
      const avatar = await avatars.getAvatar(validation.avatarId);
      if (!avatar) {
        return jsonResponse(200, { object: 'list', data: [] }, corsHeaders);
      }

      const voiceCheck = await voice.hasVoice(avatar.avatarId);

      return jsonResponse(200, {
        object: 'list',
        data: [{
          id: `avatar:${avatar.avatarId}`,
          object: 'model',
          created: Math.floor((avatar.createdAt || Date.now()) / 1000),
          owned_by: 'swarm',
          permission: [],
          root: avatar.avatarId,
          parent: null,
          // Non-standard extensions
          capabilities: {
            voice: voiceCheck.hasVoice,
          },
          // Basic avatar info
          avatar: {
            name: avatar.name,
            description: avatar.description || null,
            profile_image: avatar.profileImage?.url || null,
          },
        }],
      }, corsHeaders);
    }

    // For wildcard keys, list all public avatars
    // Note: In a real implementation, you'd want pagination
    const result = await docClient.send(new QueryCommand({
      TableName: ADMIN_TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'gsi1pk = :pk',
      ExpressionAttributeValues: {
        ':pk': 'AVATARS',
      },
      Limit: 100,
    }));

    const avatarList = (result.Items || [])
      .filter((item: Record<string, unknown>) => item.status !== 'archived')
      .map((item: Record<string, unknown>) => {
        const voiceConfig = item.voiceConfig as Record<string, unknown> | undefined;
        const hasVoiceEnabled = !!(voiceConfig?.enabled && (voiceConfig?.defaultVoiceId || voiceConfig?.referenceUrl));
        const profileImage = item.profileImage as Record<string, unknown> | undefined;
        return {
          id: `avatar:${item.avatarId}`,
          object: 'model',
          created: Math.floor((item.createdAt as number || Date.now()) / 1000),
          owned_by: 'swarm',
          permission: [],
          root: item.avatarId,
          parent: null,
          // Non-standard extensions
          capabilities: {
            voice: hasVoiceEnabled,
          },
          // Basic avatar info for listing
          avatar: {
            name: item.name || null,
            description: item.description || null,
            profile_image: profileImage?.url || null,
          },
        };
      });

    return jsonResponse(200, {
      object: 'list',
      data: avatarList,
    }, corsHeaders);
  } catch (err) {
    logger.error('Failed to list models', err);
    return errorResponse(500, 'Failed to list models', 'server_error', undefined, corsHeaders);
  }
}

/**
 * GET /v1/models/{model_id} - Get detailed info about a specific avatar
 */
async function handleGetModel(
  event: APIGatewayProxyEventV2,
  modelId: string,
  corsHeaders: Record<string, string>
): Promise<APIGatewayProxyResultV2> {
  // Validate API key
  const apiKey = extractApiKey(event);
  if (!apiKey) {
    return errorResponse(401, 'Missing API key', 'authentication_error', 'missing_api_key', corsHeaders);
  }

  const validation = await validateApiKey(apiKey);
  if (!validation.valid) {
    return errorResponse(401, validation.error || 'Invalid API key', 'authentication_error', 'invalid_api_key', corsHeaders);
  }

  try {
    // Parse model ID (strip avatar: prefix if present)
    const avatarId = modelId.replace(/^avatar:/, '');

    // Check if API key is scoped and has access to this avatar
    if (validation.avatarId && validation.avatarId !== avatarId) {
      return errorResponse(403, 'API key does not have access to this avatar', 'permission_error', 'access_denied', corsHeaders);
    }

    const avatar = await avatars.getAvatar(avatarId);
    if (!avatar) {
      return errorResponse(404, `Model not found: ${modelId}`, 'not_found', 'model_not_found', corsHeaders);
    }

    const voiceCheck = await voice.hasVoice(avatar.avatarId);

    // Build detailed model response with avatar info
    const response = {
      id: `avatar:${avatar.avatarId}`,
      object: 'model',
      created: Math.floor((avatar.createdAt || Date.now()) / 1000),
      owned_by: 'swarm',
      permission: [],
      root: avatar.avatarId,
      parent: null,
      // Non-standard extensions with avatar details
      capabilities: {
        voice: voiceCheck.hasVoice,
      },
      avatar: {
        id: avatar.avatarId,
        name: avatar.name,
        description: avatar.description || null,
        // Profile images
        profile_image: avatar.profileImage?.url || null,
        character_reference: avatar.characterReference?.url || null,
        // Platform presence
        platforms: {
          telegram: avatar.platforms?.telegram?.enabled ? {
            username: avatar.platforms.telegram.botUsername || null,
            home_channel: avatar.platforms.telegram.homeChannelUrl || null,
          } : null,
          twitter: avatar.platforms?.twitter?.enabled ? {
            username: avatar.platforms.twitter.username || null,
          } : null,
          discord: avatar.platforms?.discord?.enabled ? {
            guild_id: avatar.platforms.discord.guildId || null,
          } : null,
        },
        // Voice info
        voice: voiceCheck.hasVoice ? {
          style: voiceCheck.voiceStyle || null,
        } : null,
        // Sticker pack (if available)
        sticker_pack: avatar.stickerPack ? {
          name: avatar.stickerPack.name,
          title: avatar.stickerPack.title,
          count: avatar.stickerPack.stickerCount,
        } : null,
      },
    };

    return jsonResponse(200, response, corsHeaders);
  } catch (err) {
    logger.error('Failed to get model', err);
    return errorResponse(500, 'Failed to get model', 'server_error', undefined, corsHeaders);
  }
}

/**
 * POST /v1/chat/completions - Generate a chat completion
 */
async function handleChatCompletions(
  event: APIGatewayProxyEventV2,
  corsHeaders: Record<string, string>,
  requestId: string
): Promise<APIGatewayProxyResultV2> {
  // Validate API key
  const apiKey = extractApiKey(event);
  if (!apiKey) {
    return errorResponse(401, 'Missing API key', 'authentication_error', 'missing_api_key', corsHeaders);
  }

  const validation = await validateApiKey(apiKey);
  if (!validation.valid || !validation.session) {
    return errorResponse(401, validation.error || 'Invalid API key', 'authentication_error', 'invalid_api_key', corsHeaders);
  }

  // Parse request body
  let request: ChatCompletionRequest;
  try {
    const body = JSON.parse(event.body || '{}');
    const parseResult = ChatCompletionRequestSchema.safeParse(body);
    if (!parseResult.success) {
      const errorDetails = parseResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      return errorResponse(400, `Invalid request: ${errorDetails}`, 'invalid_request_error', undefined, corsHeaders);
    }
    request = parseResult.data;
  } catch {
    return errorResponse(400, 'Invalid JSON body', 'invalid_request_error', undefined, corsHeaders);
  }

  // Streaming not supported yet
  if (request.stream) {
    return errorResponse(400, 'Streaming is not yet supported', 'invalid_request_error', 'unsupported_stream', corsHeaders);
  }

  // Parse avatar ID from model
  const avatarId = parseAvatarId(request.model);

  // Check if API key is authorized for this avatar
  if (validation.avatarId && validation.avatarId !== avatarId) {
    return errorResponse(403, `API key not authorized for avatar: ${avatarId}`, 'permission_error', 'unauthorized_avatar', corsHeaders);
  }

  // Get avatar record
  const avatarRecord = await avatars.getAvatar(avatarId);
  if (!avatarRecord) {
    return errorResponse(404, `Avatar not found: ${avatarId}`, 'not_found', 'avatar_not_found', corsHeaders);
  }

  // Convert OpenAI messages to our internal format
  const history = request.messages.slice(0, -1).map(msg => ({
    role: msg.role as 'user' | 'assistant' | 'system',
    content: msg.content,
  }));

  const lastMessage = request.messages[request.messages.length - 1];
  const userMessage = lastMessage.role === 'user' ? lastMessage.content : null;

  // Build avatar context
  const avatarContext = {
    id: avatarRecord.avatarId,
    name: avatarRecord.name,
    description: avatarRecord.description || '',
    persona: avatarRecord.persona || '',
    enabledCategories: [] as ToolCategory[], // API users don't get tool access by default
  };

  logger.info('Processing chat completion', {
    event: 'chat_completion_start',
    subsystem: 'openai-compat',
    avatarId,
    messageCount: request.messages.length,
    requestId,
  });

  try {
    // Process the chat
    const result = await processChat(
      userMessage,
      history,
      validation.session,
      avatarContext,
      {
        maxTokens: request.max_tokens,
      }
    );

    // Build OpenAI-compatible response
    const completionId = `chatcmpl-${requestId}`;
    const created = Math.floor(Date.now() / 1000);

    // Rough token estimation (proper counting would require a tokenizer)
    const promptTokens = request.messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
    const completionTokens = Math.ceil(result.response.length / 4);

    // Generate audio if requested and avatar has voice configured
    let audioData: { url: string; format: string; duration_ms?: number } | undefined;
    if (request.include_audio) {
      try {
        const voiceCheck = await voice.hasVoice(avatarId);
        if (voiceCheck.hasVoice) {
          logger.info('Generating voice audio for response', {
            event: 'voice_generation_start',
            subsystem: 'openai-compat',
            avatarId,
            requestId,
          });

          const voiceResult = await voice.generateVoiceMessage({
            avatarId,
            text: result.response,
          });

          audioData = {
            url: voiceResult.url,
            format: voiceResult.format || 'wav',
            duration_ms: voiceResult.durationMs,
          };

          logger.info('Voice audio generated', {
            event: 'voice_generation_success',
            subsystem: 'openai-compat',
            avatarId,
            audioUrl: voiceResult.url,
            requestId,
          });
        } else {
          logger.info('Voice not configured for avatar, skipping audio generation', {
            subsystem: 'openai-compat',
            avatarId,
            requestId,
          });
        }
      } catch (voiceErr) {
        // Log but don't fail the request - audio is optional
        logger.warn('Voice generation failed, returning text only', {
          subsystem: 'openai-compat',
          avatarId,
          requestId,
          error: voiceErr instanceof Error ? voiceErr.message : String(voiceErr),
        });
      }
    }

    const response: ChatCompletionResponse = {
      id: completionId,
      object: 'chat.completion',
      created,
      model: request.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: result.response,
          ...(audioData && { audio: audioData }),
        },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };

    logger.info('Chat completion successful', {
      event: 'chat_completion_success',
      subsystem: 'openai-compat',
      avatarId,
      responseLength: result.response.length,
      hasAudio: !!audioData,
      requestId,
    });

    return jsonResponse(200, response, corsHeaders);
  } catch (err) {
    logger.error('Chat completion failed', err, {
      subsystem: 'openai-compat',
      avatarId,
      requestId,
    });

    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    return errorResponse(500, `Chat completion failed: ${errorMessage}`, 'server_error', undefined, corsHeaders);
  }
}

// =============================================================================
// API Key Management (Admin Functions)
// =============================================================================

/**
 * Generate a new API key
 * Returns the full key (only shown once) and the record to store
 */
export function generateApiKey(): { fullKey: string; record: Omit<ApiKeyRecord, 'pk' | 'sk' | 'createdAt' | 'createdBy' | 'usageCount' | 'enabled'> } {
  const randomPart = randomBytes(32).toString('base64url');
  const fullKey = `sk-${randomPart}`;
  const keyHash = hashApiKey(fullKey);
  const keyPrefix = fullKey.slice(0, 10);

  return {
    fullKey,
    record: {
      keyPrefix,
      keyHash,
      avatarId: '*', // Default to all avatars, can be scoped
      name: 'Unnamed API Key',
    },
  };
}

/**
 * Create and store a new API key
 */
export async function createApiKey(params: {
  avatarId?: string;
  name: string;
  createdBy: string;
  rateLimit?: { requestsPerMinute: number; requestsPerDay: number };
}): Promise<{ fullKey: string; keyPrefix: string }> {
  const { fullKey, record } = generateApiKey();

  const fullRecord: ApiKeyRecord = {
    pk: `API_KEY#${record.keyHash}`,
    sk: 'META',
    ...record,
    avatarId: params.avatarId || '*',
    name: params.name,
    createdAt: Date.now(),
    createdBy: params.createdBy,
    usageCount: 0,
    enabled: true,
    rateLimit: params.rateLimit,
  };

  await docClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: fullRecord.pk,
      sk: fullRecord.sk,
    },
    UpdateExpression: `
      SET keyPrefix = :keyPrefix,
          keyHash = :keyHash,
          avatarId = :avatarId,
          #name = :name,
          createdAt = :createdAt,
          createdBy = :createdBy,
          usageCount = :usageCount,
          enabled = :enabled
          ${params.rateLimit ? ', rateLimit = :rateLimit' : ''}
    `,
    ExpressionAttributeNames: {
      '#name': 'name',
    },
    ExpressionAttributeValues: {
      ':keyPrefix': fullRecord.keyPrefix,
      ':keyHash': fullRecord.keyHash,
      ':avatarId': fullRecord.avatarId,
      ':name': fullRecord.name,
      ':createdAt': fullRecord.createdAt,
      ':createdBy': fullRecord.createdBy,
      ':usageCount': fullRecord.usageCount,
      ':enabled': fullRecord.enabled,
      ...(params.rateLimit ? { ':rateLimit': params.rateLimit } : {}),
    },
  }));

  // Also store a reverse index for listing keys by avatar
  await docClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: params.avatarId ? `AVATAR#${params.avatarId}` : 'GLOBAL',
      sk: `API_KEY#${record.keyHash.slice(0, 16)}`,
    },
    UpdateExpression: 'SET keyPrefix = :keyPrefix, keyHash = :keyHash, #name = :name, createdAt = :createdAt',
    ExpressionAttributeNames: {
      '#name': 'name',
    },
    ExpressionAttributeValues: {
      ':keyPrefix': fullRecord.keyPrefix,
      ':keyHash': fullRecord.keyHash,
      ':name': fullRecord.name,
      ':createdAt': fullRecord.createdAt,
    },
  }));

  return { fullKey, keyPrefix: record.keyPrefix };
}
