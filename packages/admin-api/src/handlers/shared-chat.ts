/**
 * Shared Chat Handler
 *
 * Multi-user chat where authenticated users appear as their inhabited avatar
 * or as a "ghost" if they haven't inhabited an avatar yet.
 *
 * Features:
 * - Wallet-based authentication (SIWS)
 * - Ghost display for non-inhabiting users
 * - Avatar display for inhabiting users
 * - Per-channel message history
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z } from 'zod';
import {
  logger,
  createLLMService,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_LLM_TEMPERATURE,
  DEFAULT_LLM_MAX_TOKENS,
} from '@swarm/core';
import { getSessionWithUser } from '../services/wallet-auth.js';
import { getInhabitedAvatar } from '../services/avatar-ownership.js';
import { getClearSessionCookies, getSessionFromCookie } from '../auth/session-cookie.js';
import { getCorsHeaders } from '../http/cors.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { MessageSender } from '../types.js';
import * as avatarService from '../services/avatars.js';
import { _getSecretValueInternal } from '../services/secrets.js';

const TABLE_NAME = process.env.ADMIN_TABLE || 'SwarmAdminTable';
const MAX_MESSAGES_PER_CHANNEL = 100;
const MESSAGE_TTL_HOURS = 24;

// Rate limiting configuration
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute window
const RATE_LIMIT_MAX_MESSAGES = 10; // Max messages per user per window per channel
const RATE_LIMIT_TTL_SECONDS = 120; // TTL for rate limit records (2 minutes)

// Retry configuration
const LLM_RETRY_MAX_ATTEMPTS = 3;
const LLM_RETRY_BASE_DELAY_MS = 1000;
const LLM_RETRY_MAX_DELAY_MS = 10000;

// Typing indicator TTL
const TYPING_INDICATOR_TTL_MS = 30_000; // 30 seconds

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

// In-memory typing indicators (for Lambda warm instances)
// In production, you'd want to use DynamoDB or Redis for cross-instance state
const typingIndicators = new Map<string, { avatarName: string; startedAt: number }>();

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay with jitter
 */
function getBackoffDelay(attempt: number): number {
  const exponentialDelay = LLM_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
  return Math.min(exponentialDelay + jitter, LLM_RETRY_MAX_DELAY_MS);
}

/**
 * Retry wrapper with exponential backoff
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  channelId: string
): Promise<T | null> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < LLM_RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on certain errors (e.g., auth failures)
      const errorMessage = lastError.message.toLowerCase();
      if (errorMessage.includes('unauthorized') ||
          errorMessage.includes('forbidden') ||
          errorMessage.includes('invalid api key')) {
        logger.warn(`${operationName} failed with non-retryable error`, {
          subsystem: 'shared-chat',
          channelId,
          error: lastError.message,
          attempt: attempt + 1,
        });
        return null;
      }

      if (attempt < LLM_RETRY_MAX_ATTEMPTS - 1) {
        const delay = getBackoffDelay(attempt);
        logger.info(`${operationName} failed, retrying in ${delay}ms`, {
          subsystem: 'shared-chat',
          channelId,
          attempt: attempt + 1,
          maxAttempts: LLM_RETRY_MAX_ATTEMPTS,
          error: lastError.message,
        });
        await sleep(delay);
      }
    }
  }

  logger.error(`${operationName} failed after ${LLM_RETRY_MAX_ATTEMPTS} attempts`, lastError, {
    subsystem: 'shared-chat',
    channelId,
  });
  return null;
}

/**
 * Check if user is rate limited
 * Returns { limited: true, retryAfter: seconds } if rate limited
 */
async function checkRateLimit(
  walletAddress: string,
  channelId: string
): Promise<{ limited: boolean; retryAfter?: number }> {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const rateLimitKey = `RATE_LIMIT#${channelId}#${walletAddress}`;

  try {
    const result = await dynamoClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: rateLimitKey,
        sk: 'MESSAGES',
      },
    }));

    if (!result.Item) {
      return { limited: false };
    }

    const timestamps: number[] = result.Item.timestamps || [];
    const recentTimestamps = timestamps.filter(ts => ts > windowStart);

    if (recentTimestamps.length >= RATE_LIMIT_MAX_MESSAGES) {
      // Calculate when the oldest message in the window will expire
      const oldestInWindow = Math.min(...recentTimestamps);
      const retryAfter = Math.ceil((oldestInWindow + RATE_LIMIT_WINDOW_MS - now) / 1000);
      return { limited: true, retryAfter: Math.max(1, retryAfter) };
    }

    return { limited: false };
  } catch (error) {
    // On error, allow the request (fail open for rate limiting)
    logger.warn('Rate limit check failed, allowing request', {
      subsystem: 'shared-chat',
      channelId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { limited: false };
  }
}

/**
 * Record a message for rate limiting
 */
async function recordMessageForRateLimit(
  walletAddress: string,
  channelId: string
): Promise<void> {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const rateLimitKey = `RATE_LIMIT#${channelId}#${walletAddress}`;
  const ttl = Math.floor((now + RATE_LIMIT_TTL_SECONDS * 1000) / 1000);

  try {
    // Get existing timestamps
    const result = await dynamoClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: rateLimitKey,
        sk: 'MESSAGES',
      },
    }));

    const existingTimestamps: number[] = result.Item?.timestamps || [];
    // Keep only recent timestamps + new one
    const timestamps = [...existingTimestamps.filter(ts => ts > windowStart), now];

    await dynamoClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: rateLimitKey,
        sk: 'MESSAGES',
      },
      UpdateExpression: 'SET timestamps = :timestamps, #ttl = :ttl',
      ExpressionAttributeNames: {
        '#ttl': 'ttl',
      },
      ExpressionAttributeValues: {
        ':timestamps': timestamps,
        ':ttl': ttl,
      },
    }));
  } catch (error) {
    // Non-critical, just log
    logger.warn('Failed to record message for rate limit', {
      subsystem: 'shared-chat',
      channelId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Set typing indicator for a channel
 */
function setTypingIndicator(channelId: string, avatarName: string): void {
  typingIndicators.set(channelId, { avatarName, startedAt: Date.now() });
}

/**
 * Clear typing indicator for a channel
 */
function clearTypingIndicator(channelId: string): void {
  typingIndicators.delete(channelId);
}

/**
 * Get typing indicator for a channel (if still valid)
 */
function getTypingIndicator(channelId: string): { avatarName: string } | null {
  const indicator = typingIndicators.get(channelId);
  if (!indicator) return null;

  // Check if expired
  if (Date.now() - indicator.startedAt > TYPING_INDICATOR_TTL_MS) {
    typingIndicators.delete(channelId);
    return null;
  }

  return { avatarName: indicator.avatarName };
}

// =============================================================================
// Types
// =============================================================================

export interface SharedChatMessage {
  id: string;
  channelId: string;
  content: string;
  sender: MessageSender;
  timestamp: number;
  replyToId?: string;
}

export interface SharedChatChannel {
  pk: string;  // SHARED_CHAT#{channelId}
  sk: string;  // MESSAGES
  channelId: string;
  channelName?: string;
  messages: SharedChatMessage[];
  updatedAt: number;
  ttl: number;
}

/**
 * Public avatar info for the channel header
 */
export interface ChannelAvatarInfo {
  avatarId: string;
  name: string;
  description?: string;
  profileImageUrl?: string;
  persona?: string;
}

// Request schemas
const SendMessageSchema = z.object({
  channelId: z.string().min(1),
  content: z.string().min(1).max(4000),
  replyToId: z.string().optional(),
});

// Cookie helpers live in ../auth/session-cookie.ts

// =============================================================================
// Response Helpers
// =============================================================================

function jsonResponse(
  statusCode: number,
  body: unknown,
  headers?: Record<string, string>,
  cookies?: string[]
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    cookies,
    body: JSON.stringify(body),
  };
}

function corsHeaders(event: APIGatewayProxyEventV2): Record<string, string> {
  return getCorsHeaders(event);
}

// =============================================================================
// Avatar Info
// =============================================================================

/**
 * Get public avatar info for the channel (avatar page)
 * Returns null if avatar not found
 */
async function getChannelAvatarInfo(channelId: string): Promise<ChannelAvatarInfo | null> {
  // channelId is the avatarId
  const avatar = await avatarService.getAvatar(channelId);
  if (!avatar) return null;

  return {
    avatarId: avatar.avatarId,
    name: avatar.name,
    description: avatar.description,
    profileImageUrl: avatar.profileImage?.url,
    persona: avatar.persona,
  };
}

// =============================================================================
// Sender Identity
// =============================================================================

/**
 * Build the sender identity from wallet session
 * Returns ghost if authenticated but not inhabiting, avatar if inhabiting
 */
async function buildSenderIdentity(walletAddress: string): Promise<MessageSender> {
  const inhabitedAvatar = await getInhabitedAvatar(walletAddress);

  if (!inhabitedAvatar) {
    // Ghost user - authenticated but no avatar
    return {
      walletAddress,
      displayName: `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`,
      isGhost: true,
    };
  }

  // Inhabiting user - show as avatar
  return {
    walletAddress,
    displayName: inhabitedAvatar.name,
    avatarUrl: inhabitedAvatar.profileImage?.url,
    inhabitedAvatarId: inhabitedAvatar.avatarId,
    inhabitedAvatarName: inhabitedAvatar.name,
    isGhost: false,
  };
}

// =============================================================================
// Channel Storage
// =============================================================================

/**
 * Get messages from a shared chat channel
 */
async function getChannelMessages(channelId: string): Promise<SharedChatMessage[]> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `SHARED_CHAT#${channelId}`,
      sk: 'MESSAGES',
    },
  }));

  if (!result.Item) {
    return [];
  }

  return (result.Item as SharedChatChannel).messages || [];
}

/**
 * Add a message to a shared chat channel
 */
async function addChannelMessage(
  channelId: string,
  message: SharedChatMessage
): Promise<void> {
  const now = Date.now();
  const ttl = Math.floor((now + MESSAGE_TTL_HOURS * 60 * 60 * 1000) / 1000);

  // Get existing messages
  const existingMessages = await getChannelMessages(channelId);

  // Add new message and trim to max
  const messages = [...existingMessages, message].slice(-MAX_MESSAGES_PER_CHANNEL);

  await dynamoClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `SHARED_CHAT#${channelId}`,
      sk: 'MESSAGES',
    },
    UpdateExpression: 'SET messages = :messages, channelId = :channelId, updatedAt = :now, #ttl = :ttl',
    ExpressionAttributeNames: {
      '#ttl': 'ttl',
    },
    ExpressionAttributeValues: {
      ':messages': messages,
      ':channelId': channelId,
      ':now': now,
      ':ttl': ttl,
    },
  }));
}

// =============================================================================
// Avatar Response Generation
// =============================================================================

/**
 * Generate an avatar response to a user message
 * Returns null if avatar is not configured for responses or if generation fails
 */
async function generateAvatarResponse(
  channelId: string,
  userMessage: SharedChatMessage,
  recentMessages: SharedChatMessage[]
): Promise<string | null> {
  try {
    // Get avatar config - channelId is the avatarId
    const avatar = await avatarService.getAvatar(channelId);
    if (!avatar) {
      logger.warn('Avatar not found for response generation', {
        subsystem: 'shared-chat',
        channelId,
      });
      return null;
    }

    // Check if avatar is active
    if (avatar.status !== 'active') {
      logger.info('Avatar not active, skipping response', {
        subsystem: 'shared-chat',
        channelId,
        status: avatar.status,
      });
      return null;
    }

    // Get LLM API key (avatar-specific or global)
    let apiKey = await _getSecretValueInternal(channelId, 'openrouter_api_key', 'default');
    if (!apiKey) {
      apiKey = await _getSecretValueInternal(null, 'openrouter_api_key', 'default');
    }
    if (!apiKey) {
      logger.warn('No OpenRouter API key found for avatar response', {
        subsystem: 'shared-chat',
        channelId,
      });
      return null;
    }

    // Build LLM config from avatar settings
    const provider = (avatar.llmConfig?.provider || DEFAULT_LLM_PROVIDER) as 'openrouter' | 'bedrock' | 'anthropic';
    const llmConfig = {
      provider,
      model: avatar.llmConfig?.model || DEFAULT_LLM_MODEL,
      temperature: avatar.llmConfig?.temperature ?? DEFAULT_LLM_TEMPERATURE,
      maxTokens: avatar.llmConfig?.maxTokens ?? DEFAULT_LLM_MAX_TOKENS,
    };

    // Create LLM service
    const llmService = createLLMService(llmConfig, { OPENROUTER_API_KEY: apiKey });

    // Build system prompt from persona
    const systemPrompt = avatar.persona
      ? `You are ${avatar.name}. ${avatar.persona}

You are in a group chat. Each message is formatted as "Username: message content" where Username is either:
- A wallet address like "4aFQ...dqJ8" for anonymous users
- An avatar name for users inhabiting an avatar

Address users by their name/wallet when responding. Keep responses concise and conversational.`
      : `You are ${avatar.name}, a helpful AI assistant.

You are in a group chat. Each message is formatted as "Username: message content" where Username is either:
- A wallet address like "4aFQ...dqJ8" for anonymous users
- An avatar name for users inhabiting an avatar

Address users by their name/wallet when responding. Keep responses concise and conversational.`;

    // Build conversation history for context (last 10 messages)
    const contextMessages = recentMessages.slice(-10).map(msg => ({
      role: (msg.sender.inhabitedAvatarId === channelId ? 'assistant' : 'user') as 'user' | 'assistant' | 'system',
      content: `${msg.sender.displayName}: ${msg.content}`,
    }));

    // Add the current user message
    contextMessages.push({
      role: 'user' as const,
      content: `${userMessage.sender.displayName}: ${userMessage.content}`,
    });

    // Generate response with retry logic
    const response = await withRetry(
      async () => {
        const result = await llmService.generateResponse({
          avatarId: channelId,
          systemPrompt,
          messages: contextMessages,
          tools: [],
          config: llmConfig,
        });

        if (!result.content) {
          throw new Error('Empty LLM response');
        }

        return result;
      },
      'LLM response generation',
      channelId
    );

    if (!response?.content) {
      return null;
    }

    logger.info('Avatar response generated', {
      subsystem: 'shared-chat',
      channelId,
      avatarName: avatar.name,
      responseLength: response.content.length,
    });

    return response.content;
  } catch (error) {
    logger.error('Avatar response generation failed', error, {
      subsystem: 'shared-chat',
      channelId,
    });
    return null;
  }
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * GET /shared-chat/messages?channelId=xxx
 * Get messages from a shared chat channel
 */
export async function handleGetMessages(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = corsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Require authentication
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(401, { error: 'Authentication required' }, cors);
    }

    const session = await getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(401, { error: 'Session expired' }, cors, getClearSessionCookies());
    }

    const channelId = event.queryStringParameters?.channelId;
    if (!channelId) {
      return jsonResponse(400, { error: 'channelId is required' }, cors);
    }

    const [messages, avatarInfo] = await Promise.all([
      getChannelMessages(channelId),
      getChannelAvatarInfo(channelId),
    ]);

    // Also return the current user's sender identity
    const sender = await buildSenderIdentity(session.user.walletAddress);

    return jsonResponse(200, {
      messages,
      sender,
      avatar: avatarInfo,
    }, cors);
  } catch (error) {
    logger.error('Get messages error', error, { subsystem: 'shared-chat' });
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * POST /shared-chat/messages
 * Send a message to a shared chat channel
 */
export async function handleSendMessage(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = corsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Require authentication
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(401, { error: 'Authentication required' }, cors);
    }

    const session = await getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(401, { error: 'Session expired' }, cors, getClearSessionCookies());
    }

    // Parse request
    const body = JSON.parse(event.body || '{}');
    const parsed = SendMessageSchema.safeParse(body);

    if (!parsed.success) {
      return jsonResponse(400, {
        error: 'Invalid request',
        details: parsed.error.issues,
      }, cors);
    }

    const { channelId, content, replyToId } = parsed.data;
    const walletAddress = session.user.walletAddress;

    // Check rate limit
    const rateLimitStatus = await checkRateLimit(walletAddress, channelId);
    if (rateLimitStatus.limited) {
      logger.info('User rate limited', {
        subsystem: 'shared-chat',
        channelId,
        walletAddress: `${walletAddress.slice(0, 6)}...`,
        retryAfter: rateLimitStatus.retryAfter,
      });
      return jsonResponse(429, {
        error: 'Too many messages. Please slow down.',
        retryAfter: rateLimitStatus.retryAfter,
      }, {
        ...cors,
        'Retry-After': String(rateLimitStatus.retryAfter),
      });
    }

    // Parallel: Build sender identity + get avatar info (for typing indicator)
    const [sender, avatar] = await Promise.all([
      buildSenderIdentity(walletAddress),
      avatarService.getAvatar(channelId),
    ]);

    // Create message
    const message: SharedChatMessage = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      channelId,
      content,
      sender,
      timestamp: Date.now(),
      replyToId,
    };

    // Parallel: Save message + record rate limit
    await Promise.all([
      addChannelMessage(channelId, message),
      recordMessageForRateLimit(walletAddress, channelId),
    ]);

    logger.info('Message sent', {
      subsystem: 'shared-chat',
      isGhost: sender.isGhost,
      avatarName: sender.inhabitedAvatarName,
      channelId,
    });

    // Set typing indicator before generating response
    if (avatar && avatar.status === 'active') {
      setTypingIndicator(channelId, avatar.name);
    }

    // Generate avatar response
    // Get recent messages for context (message already saved, so it's included)
    const recentMessages = await getChannelMessages(channelId);
    const avatarResponseText = await generateAvatarResponse(channelId, message, recentMessages);

    // Clear typing indicator
    clearTypingIndicator(channelId);

    let avatarMessage: SharedChatMessage | null = null;
    if (avatarResponseText && avatar) {
      avatarMessage = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
        channelId,
        content: avatarResponseText,
        sender: {
          walletAddress: 'avatar',
          displayName: avatar.name,
          avatarUrl: avatar.profileImage?.url,
          inhabitedAvatarId: avatar.avatarId,
          inhabitedAvatarName: avatar.name,
          isGhost: false,
        },
        timestamp: Date.now(),
        replyToId: message.id,
      };

      // Save avatar response
      await addChannelMessage(channelId, avatarMessage);

      logger.info('Avatar response sent', {
        subsystem: 'shared-chat',
        avatarName: avatar.name,
        channelId,
      });
    }

    return jsonResponse(200, {
      success: true,
      message,
      avatarResponse: avatarMessage,
    }, cors);
  } catch (error) {
    logger.error('Send message error', error, { subsystem: 'shared-chat' });
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * GET /shared-chat/identity
 * Get the current user's sender identity (ghost or avatar)
 */
export async function handleGetIdentity(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = corsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Require authentication
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(401, { error: 'Authentication required' }, cors);
    }

    const session = await getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(401, { error: 'Session expired' }, cors, getClearSessionCookies());
    }

    const sender = await buildSenderIdentity(session.user.walletAddress);

    return jsonResponse(200, { sender }, cors);
  } catch (error) {
    logger.error('Get identity error', error, { subsystem: 'shared-chat' });
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * GET /shared-chat/typing?channelId=xxx
 * Get typing indicator status for a channel
 * Returns { typing: true, avatarName: "..." } if avatar is currently generating a response
 */
export async function handleGetTypingStatus(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = corsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    const channelId = event.queryStringParameters?.channelId;
    if (!channelId) {
      return jsonResponse(400, { error: 'channelId is required' }, cors);
    }

    const indicator = getTypingIndicator(channelId);

    if (indicator) {
      return jsonResponse(200, {
        typing: true,
        avatarName: indicator.avatarName,
      }, cors);
    }

    return jsonResponse(200, { typing: false }, cors);
  } catch (error) {
    logger.error('Get typing status error', error, { subsystem: 'shared-chat' });
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * GET /shared-chat/avatar?channelId=xxx
 * Get the avatar info for a channel (public endpoint, no auth required)
 * Used for displaying the avatar header on shared chat pages
 */
export async function handleGetAvatar(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = corsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    const channelId = event.queryStringParameters?.channelId;
    if (!channelId) {
      return jsonResponse(400, { error: 'channelId is required' }, cors);
    }

    const avatarInfo = await getChannelAvatarInfo(channelId);

    if (!avatarInfo) {
      return jsonResponse(404, { error: 'Avatar not found' }, cors);
    }

    return jsonResponse(200, { avatar: avatarInfo }, cors);
  } catch (error) {
    logger.error('Get avatar error', error, { subsystem: 'shared-chat' });
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * Main router for /shared-chat/* endpoints
 */
export async function handleSharedChat(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const rawPath = event.rawPath;
  const path = rawPath === '/api'
    ? '/'
    : rawPath.startsWith('/api/')
      ? rawPath.slice('/api'.length)
      : rawPath;
  const method = event.requestContext.http.method;
  const cors = corsHeaders(event);

  // Handle preflight for all routes
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  // Route to appropriate handler
  if (path === '/shared-chat/messages' && method === 'GET') {
    return handleGetMessages(event);
  }

  if (path === '/shared-chat/messages' && method === 'POST') {
    return handleSendMessage(event);
  }

  if (path === '/shared-chat/identity' && method === 'GET') {
    return handleGetIdentity(event);
  }

  if (path === '/shared-chat/typing' && method === 'GET') {
    return handleGetTypingStatus(event);
  }

  // Public endpoint - no auth required
  if (path === '/shared-chat/avatar' && method === 'GET') {
    return handleGetAvatar(event);
  }

  return jsonResponse(404, { error: 'Not found' }, cors);
}
