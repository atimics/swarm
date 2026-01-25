/**
 * Shared Telegram Webhook Handler (multi-tenant)
 *
 * This is the preferred ingress path when using the shared @swarm/handlers runtime:
 * - Loads avatar config from STATE_TABLE
 * - Verifies Telegram webhook secret token (if configured)
 * - Blocks DMs (private chats)
 * - Evaluates whether to respond
 * - Enqueues the message to the shared FIFO message queue
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID, timingSafeEqual } from 'crypto';
import {
  TelegramAdapter,
  createMessageEvaluator,
  createStateService,
  logger,
  type AvatarConfig,
} from '@swarm/core';

const sqs = new SQSClient({});
const secretsClient = new SecretsManagerClient({});
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const MESSAGE_QUEUE_URL = process.env.MESSAGE_QUEUE_URL!;
const STATE_TABLE = process.env.STATE_TABLE!;
const ADMIN_TABLE = process.env.ADMIN_TABLE;
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'swarm';
const INTERNAL_TEST_KEY = process.env.INTERNAL_TEST_KEY;

// Lazy-initialized services
let stateService: ReturnType<typeof createStateService>;

// Per-avatar caches
const avatarConfigCache = new Map<string, { value: AvatarConfig; expiresAt: number }>();
const telegramAdapterCache = new Map<string, { value: TelegramAdapter; expiresAt: number }>();
const botTokenCache = new Map<string, { value: string; expiresAt: number }>();
const webhookSecretCache = new Map<string, { value: string; expiresAt: number }>();

const CONFIG_TTL_MS = 60_000;
const TOKEN_TTL_MS = 5 * 60_000;
const WEBHOOK_SECRET_TTL_MS = 5 * 60_000;
const HOME_CHANNEL_CACHE_TTL_MS = 60_000;
const ACTIVE_CHANNEL_CACHE_TTL_MS = 60_000;

// Home channel cache (set of chat IDs that are home channels)
let homeChannelCache: { ids: Set<string>; expiresAt: number } | null = null;

// Per-avatar active channel cache (most recently active channel)
const activeChannelCache = new Map<string, { chatId: string; expiresAt: number }>();

// Redirect message for blocked channels/DMs
const REDIRECT_MESSAGE = `I can only chat in my home channel! Join us:

🌐 https://swarm.rati.chat/
💬 https://t.me/ratichat
🪙 $RATiOS: 281Qdc3ZcPQtn8odD9p4GyhzBSko1r5jmQrNU1dQBAGS`;

/**
 * Get the most recently active channel for an avatar.
 * Used as a fallback when no home channel is explicitly configured.
 * Queries channel state records and returns the one with most recent activity.
 */
async function getMostRecentActiveChannel(avatarId: string): Promise<string | null> {
  const now = Date.now();
  const cached = activeChannelCache.get(avatarId);
  if (cached && cached.expiresAt > now) {
    return cached.chatId;
  }

  if (!ADMIN_TABLE) {
    return null;
  }

  try {
    // Scan channel state records for this avatar
    // Channel records have pk like "CHANNEL#{avatarId}#{chatId}"
    const result = await dynamoClient.send(new ScanCommand({
      TableName: ADMIN_TABLE,
      FilterExpression: 'begins_with(pk, :prefix) AND sk = :sk AND chatType <> :private',
      ExpressionAttributeValues: {
        ':prefix': `CHANNEL#${avatarId}#`,
        ':sk': 'STATE',
        ':private': 'private',
      },
      ProjectionExpression: 'chatId, lastActivityAt, messageCount',
    }));

    if (!result.Items || result.Items.length === 0) {
      return null;
    }

    // Find the channel with most recent activity (or highest message count as tiebreaker)
    let bestChannel: { chatId: number; lastActivityAt: number; messageCount: number } | null = null;
    for (const item of result.Items) {
      const chatId = item.chatId as number;
      const lastActivityAt = (item.lastActivityAt as number) || 0;
      const messageCount = (item.messageCount as number) || 0;

      if (!bestChannel ||
          lastActivityAt > bestChannel.lastActivityAt ||
          (lastActivityAt === bestChannel.lastActivityAt && messageCount > bestChannel.messageCount)) {
        bestChannel = { chatId, lastActivityAt, messageCount };
      }
    }

    if (bestChannel) {
      const chatIdStr = String(bestChannel.chatId);
      activeChannelCache.set(avatarId, { chatId: chatIdStr, expiresAt: now + ACTIVE_CHANNEL_CACHE_TTL_MS });
      logger.info('Found most recent active channel', { avatarId, chatId: chatIdStr, lastActivityAt: bestChannel.lastActivityAt });
      return chatIdStr;
    }

    return null;
  } catch (err) {
    logger.warn('Failed to fetch active channels', { avatarId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Get all home channel IDs from the registry.
 * Uses in-memory caching with 60 second TTL.
 */
async function getHomeChannelIds(): Promise<Set<string>> {
  if (!ADMIN_TABLE) {
    // ADMIN_TABLE not configured, home channel feature disabled
    return new Set();
  }

  const now = Date.now();
  if (homeChannelCache && homeChannelCache.expiresAt > now) {
    return homeChannelCache.ids;
  }

  try {
    const result = await dynamoClient.send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': 'HOME_CHANNELS',
      },
      ProjectionExpression: 'sk', // sk = chatId
    }));

    const ids = new Set<string>();
    for (const item of result.Items || []) {
      if (item.sk) {
        ids.add(item.sk as string);
      }
    }

    homeChannelCache = { ids, expiresAt: now + HOME_CHANNEL_CACHE_TTL_MS };
    return ids;
  } catch (err) {
    logger.warn('Failed to fetch home channels', { error: err instanceof Error ? err.message : String(err) });
    return new Set();
  }
}

/**
 * Create a home channel checker for a specific avatar.
 * Checks if a chat ID is a registered home channel, with fallback to most recently active channel.
 */
function createHomeChannelChecker(avatarId: string): HomeChannelChecker {
  return {
    async isHomeChannel(chatId: string, avatarHomeChannelId?: string): Promise<boolean> {
      // Fast path: check if it's the avatar's own home channel
      if (avatarHomeChannelId && chatId === avatarHomeChannelId) {
        return true;
      }

      // Check against all registered home channels
      const homeChannelIds = await getHomeChannelIds();
      if (homeChannelIds.has(chatId)) {
        return true;
      }

      // Fallback: if avatar has no home channel configured, allow most recently active channel
      // This prevents avatars from being completely blocked when first deploying
      if (!avatarHomeChannelId && homeChannelIds.size === 0) {
        // No home channels registered at all - allow all (legacy behavior during migration)
        logger.info('No home channels registered, allowing all channels (migration mode)');
        return true;
      }

      if (!avatarHomeChannelId) {
        // Avatar has no home channel configured - check if this is their most active channel
        const mostActiveChannel = await getMostRecentActiveChannel(avatarId);
        if (mostActiveChannel && chatId === mostActiveChannel) {
          logger.info('Allowing most recently active channel as fallback', { avatarId, chatId });
          return true;
        }
      }

      return false;
    },
  };
}

/**
 * Interface for home channel checking (dependency injection).
 * This allows the webhook handler to check home channels without depending on admin-api.
 */
export interface HomeChannelChecker {
  isHomeChannel: (chatId: string, avatarHomeChannelId?: string) => Promise<boolean>;
}

/**
 * Check if a Telegram chat is allowed for this avatar.
 *
 * For DMs (private chats): Uses allowedDmUserIds allowlist.
 * For groups/channels: Uses home channel logic if homeChannelChecker is provided,
 *                      otherwise falls back to allowedChatIds allowlist.
 *
 * @param envelope - The message envelope with chat info
 * @param telegramCfg - The avatar's Telegram configuration
 * @param homeChannelChecker - Optional: checker for home channel validation
 * @returns true if the chat is allowed, false otherwise
 */
export function isTelegramChatAllowed(
  envelope: {
    conversationId: string;
    sender: { id: string | number; platformUserId?: string | number };
    metadata: { chatType?: string };
  },
  telegramCfg: { allowedChatIds?: string[]; allowedDmUserIds?: string[]; homeChannelId?: string } | undefined,
  homeChannelChecker?: HomeChannelChecker
): boolean | Promise<boolean> {
  // DMs: allow only if user is allowlisted
  if (envelope.metadata.chatType === 'private') {
    const allowedDmUserIds = telegramCfg?.allowedDmUserIds;
    const userId = envelope.sender.platformUserId ?? envelope.sender.id;

    return !!allowedDmUserIds && allowedDmUserIds.length > 0 && allowedDmUserIds.includes(String(userId));
  }

  // Groups/channels: use home channel logic if checker is provided
  if (homeChannelChecker) {
    return homeChannelChecker.isHomeChannel(
      envelope.conversationId,
      telegramCfg?.homeChannelId
    );
  }

  // Fallback: optional allowlist by chat ID (legacy behavior)
  const allowedChatIds = telegramCfg?.allowedChatIds;
  if (allowedChatIds && allowedChatIds.length > 0) {
    return allowedChatIds.includes(envelope.conversationId);
  }

  return true;
}

async function initialize(): Promise<void> {
  if (stateService) return;
  stateService = createStateService(STATE_TABLE);
}

function ok(): APIGatewayProxyResultV2 {
  return { statusCode: 200, body: 'OK' };
}

function lowerHeaders(headers: Record<string, string | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k.toLowerCase()] = v || '';
  }
  return out;
}

async function getWebhookSecret(avatarId: string): Promise<string | null> {
  const now = Date.now();
  const cached = webhookSecretCache.get(avatarId);
  if (cached && cached.expiresAt > now) return cached.value;

  const secretName = `${SECRET_PREFIX}/${avatarId}/telegram_webhook_secret/default`;
  try {
    const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
    const value = response.SecretString || '';
    if (!value) return null;
    webhookSecretCache.set(avatarId, { value, expiresAt: now + WEBHOOK_SECRET_TTL_MS });
    return value;
  } catch {
    return null;
  }
}

function verifySecretToken(provided: string | undefined, expected: string): boolean {
  const providedBuf = Buffer.from(provided || '');
  const expectedBuf = Buffer.from(expected);
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}

async function getAvatarConfig(avatarId: string): Promise<AvatarConfig | null> {
  const now = Date.now();
  const cached = avatarConfigCache.get(avatarId);
  if (cached && cached.expiresAt > now) return cached.value;

  const config = await stateService.getAvatarConfig(avatarId);
  if (!config) return null;

  avatarConfigCache.set(avatarId, { value: config, expiresAt: now + CONFIG_TTL_MS });
  return config;
}

async function getBotToken(avatarId: string): Promise<string | null> {
  const now = Date.now();
  const cached = botTokenCache.get(avatarId);
  if (cached && cached.expiresAt > now) return cached.value;

  // Use direct Secrets Manager path (same pattern as getWebhookSecret)
  const secretName = `${SECRET_PREFIX}/${avatarId}/telegram_bot_token/default`;
  try {
    logger.info('Fetching bot token from Secrets Manager', { avatarId, secretName });
    const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
    const token = response.SecretString || '';
    if (!token) {
      logger.warn('Bot token secret is empty', { avatarId, secretName });
      return null;
    }
    logger.info('Successfully retrieved bot token', { avatarId, tokenLength: token.length });
    botTokenCache.set(avatarId, { value: token, expiresAt: now + TOKEN_TTL_MS });
    return token;
  } catch (error: unknown) {
    const err = error as { name?: string; message?: string; code?: string; $metadata?: unknown };
    logger.error('Failed to get bot token from Secrets Manager', undefined, {
      avatarId,
      secretName,
      errorMessage: err.message || 'Unknown error',
      errorName: err.name || 'Unknown',
      errorCode: err.code,
      metadata: err.$metadata ? JSON.stringify(err.$metadata) : undefined,
    });
    return null;
  }
}

async function getTelegramAdapter(avatarId: string, avatarConfig: AvatarConfig): Promise<TelegramAdapter | null> {
  const now = Date.now();
  const cached = telegramAdapterCache.get(avatarId);
  if (cached && cached.expiresAt > now) return cached.value;

  const token = await getBotToken(avatarId);
  if (!token) return null;

  const adapter = new TelegramAdapter(avatarConfig, token);
  telegramAdapterCache.set(avatarId, { value: adapter, expiresAt: now + TOKEN_TTL_MS });
  return adapter;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const startTime = Date.now();
  const avatarId = event.pathParameters?.avatarId;
  const requestId = event.requestContext.requestId;

  const headers = lowerHeaders(event.headers);
  const traceId = headers['x-trace-id'] || randomUUID();

  logger.setContext({ subsystem: 'telegram', avatarId, requestId, traceId });
  logger.info('Telegram webhook received', { event: 'request_received' });

  try {
    await initialize();

    if (!avatarId || !/^[a-zA-Z0-9_-]+$/.test(avatarId)) {
      logger.warn('Invalid avatarId');
      return ok();
    }

    const body = event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf-8') : Buffer.from('');

    const avatarConfig = await getAvatarConfig(avatarId);
    if (!avatarConfig?.platforms.telegram?.enabled) {
      logger.info('Telegram disabled or config missing');
      return ok();
    }

    const telegramAdapter = await getTelegramAdapter(avatarId, avatarConfig);
    if (!telegramAdapter) {
      logger.error('Missing Telegram bot token');
      return ok();
    }

    // Verify webhook secret token if configured, otherwise fall back to adapter verification
    // Allow bypass with internal test key for E2E testing
    const internalTestKey = headers['x-internal-test-key'];
    const bypassAuth = INTERNAL_TEST_KEY && internalTestKey === INTERNAL_TEST_KEY;
    
    if (!bypassAuth) {
      const webhookSecret = await getWebhookSecret(avatarId);
      if (webhookSecret) {
        const provided = headers['x-telegram-bot-api-secret-token'];
        if (!verifySecretToken(provided, webhookSecret)) {
          logger.warn('Invalid webhook secret', { event: 'validation_error', reason: 'invalid_secret' });
          return { statusCode: 401, body: 'Unauthorized' };
        }
      } else {
        const isValid = await telegramAdapter.verifyRequest(body, headers);
        if (!isValid) {
          logger.warn('Invalid request signature', { event: 'validation_error', reason: 'invalid_signature' });
          return { statusCode: 401, body: 'Unauthorized' };
        }
      }
    }

    let update: unknown;
    try {
      update = JSON.parse(body.toString());
    } catch (err) {
      logger.warn('Invalid JSON', { event: 'parse_error', error: err instanceof Error ? err.message : String(err) });
      return { statusCode: 400, body: 'Invalid JSON' };
    }

    const envelope = await telegramAdapter.parseMessage(update);
    if (!envelope) return ok();

    envelope.traceId = traceId;

    const telegramCfg = avatarConfig.platforms.telegram;
    // Use home channel checker for groups/channels if ADMIN_TABLE is configured
    const homeChecker = ADMIN_TABLE ? createHomeChannelChecker(avatarId) : undefined;
    const chatAllowed = await Promise.resolve(isTelegramChatAllowed(envelope, telegramCfg, homeChecker));
    if (!chatAllowed) {
      const isMentioned = envelope.metadata.isMention || envelope.metadata.isReplyToBot;

      if (envelope.metadata.chatType === 'private') {
        const userId = envelope.sender.platformUserId ?? envelope.sender.id;
        logger.info('DM blocked (not allowlisted)', { event: 'chat_blocked', chatType: 'private', userId });
      } else {
        logger.info('Chat not in home channel registry', { event: 'chat_blocked', chatId: envelope.conversationId });
      }

      // Send redirect message if the avatar was mentioned or replied to
      if (isMentioned) {
        try {
          const bot = telegramAdapter.getBot();
          if (bot) {
            await bot.api.sendMessage(
              parseInt(envelope.conversationId),
              REDIRECT_MESSAGE,
              { reply_to_message_id: parseInt(envelope.messageId) }
            );
            logger.info('Sent redirect message', { event: 'redirect_sent', chatId: envelope.conversationId });
          }
        } catch (err) {
          logger.warn('Failed to send redirect message', {
            error: err instanceof Error ? err.message : String(err),
            chatId: envelope.conversationId
          });
        }
      }

      return ok();
    }

    // Idempotency
    const isNewMessage = await stateService.checkAndSetIdempotency(envelope.metadata.idempotencyKey);
    if (!isNewMessage) {
      logger.info('Duplicate message, skipping', { messageId: envelope.messageId });
      return ok();
    }

    // Evaluate if we should respond
    const evaluator = createMessageEvaluator(avatarConfig, stateService, {
      botUsernames: [avatarConfig.platforms.telegram?.botUsername || ''],
    });

    const evaluation = await evaluator.evaluate(envelope);
    if (!evaluation.shouldRespond) {
      logger.info('Not responding', { reason: evaluation.reason });
      return ok();
    }

    envelope.metadata.shouldRespond = evaluation.shouldRespond;
    envelope.metadata.responseReason = evaluation.reason;
    envelope.metadata.priority = evaluation.priority;

    const normalizedChatType =
      envelope.metadata.chatType === 'private' ||
      envelope.metadata.chatType === 'group' ||
      envelope.metadata.chatType === 'supergroup' ||
      envelope.metadata.chatType === 'channel'
        ? envelope.metadata.chatType
        : undefined;

    await stateService.addMessageToChannel(
      avatarId,
      envelope.conversationId,
      'telegram',
      {
        messageId: envelope.messageId,
        sender: envelope.sender.displayName || envelope.sender.username || envelope.sender.id,
        isBot: envelope.sender.isBot,
        content: envelope.content.text || '[media]',
        timestamp: envelope.timestamp,
      },
      undefined,
      normalizedChatType,
      envelope.metadata.chatTitle
    );

    await sqs.send(new SendMessageCommand({
      QueueUrl: MESSAGE_QUEUE_URL,
      MessageBody: JSON.stringify({
        envelope,
        enqueuedAt: Date.now(),
        attempts: 0,
        maxAttempts: 3,
      }),
      MessageAttributes: {
        traceId: { DataType: 'String', StringValue: traceId },
      },
      MessageGroupId: `${avatarId}#${envelope.conversationId}`,
      MessageDeduplicationId: envelope.metadata.idempotencyKey,
    }));

    logger.info('Message queued', {
      event: 'message_queued',
      messageId: envelope.messageId,
      reason: evaluation.reason,
      durationMs: Date.now() - startTime,
    });

    return ok();
  } catch (err) {
    logger.error('Telegram webhook handler error', err, { event: 'handler_error' });
    // Telegram will retry on non-200. We generally want to ACK to avoid retries.
    return ok();
  }
}
