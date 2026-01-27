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
import { DynamoDBDocumentClient, QueryCommand, DeleteCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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

// Home channel cache (set of chat IDs that are home channels)
let homeChannelCache: { ids: Set<string>; expiresAt: number } | null = null;

// Default values for redirect message
const DEFAULT_HOME_CHANNEL_URL = 'https://t.me/ratichat';
const DEFAULT_COIN_SYMBOL = '$RATiOS';
const DEFAULT_COIN_ADDRESS = '281Qdc3ZcPQtn8odD9p4GyhzBSko1r5jmQrNU1dQBAGS';

/**
 * Build redirect message for blocked channels.
 * Uses avatar-specific config if available, otherwise falls back to defaults.
 */
function buildRedirectMessage(telegramCfg?: {
  homeChannelUrl?: string;
  homeChannelUsername?: string;
  coinSymbol?: string;
  coinAddress?: string;
}): string {
  const homeChannelUrl = telegramCfg?.homeChannelUrl
    || (telegramCfg?.homeChannelUsername ? `https://t.me/${telegramCfg.homeChannelUsername}` : DEFAULT_HOME_CHANNEL_URL);
  const coinSymbol = telegramCfg?.coinSymbol || DEFAULT_COIN_SYMBOL;
  const coinAddress = telegramCfg?.coinAddress || DEFAULT_COIN_ADDRESS;

  return `I can only chat in my home channel! Join us:

🌐 https://swarm.rati.chat/
💬 ${homeChannelUrl}
🪙 ${coinSymbol}: ${coinAddress}`;
}


/**
 * Clean up channel state when bot is removed from a channel.
 * Deletes the channel state record from both STATE_TABLE and ADMIN_TABLE.
 */
async function cleanupChannelState(avatarId: string, chatId: string): Promise<void> {
  const deletePromises: Promise<unknown>[] = [];

  // Delete from STATE_TABLE (core channel state)
  if (STATE_TABLE) {
    deletePromises.push(
      dynamoClient.send(new DeleteCommand({
        TableName: STATE_TABLE,
        Key: {
          pk: `AVATAR#${avatarId}`,
          sk: `CHANNEL#${chatId}#STATE`,
        },
      })).catch(err => {
        logger.warn('Failed to delete channel state from STATE_TABLE', {
          avatarId,
          chatId,
          error: err instanceof Error ? err.message : String(err),
        });
      })
    );
  }

  // Delete from ADMIN_TABLE (admin-api channel state)
  if (ADMIN_TABLE) {
    deletePromises.push(
      dynamoClient.send(new DeleteCommand({
        TableName: ADMIN_TABLE,
        Key: {
          pk: `CHANNEL#${avatarId}#${chatId}`,
          sk: 'STATE',
        },
      })).catch(err => {
        logger.warn('Failed to delete channel state from ADMIN_TABLE', {
          avatarId,
          chatId,
          error: err instanceof Error ? err.message : String(err),
        });
      })
    );
  }

  await Promise.all(deletePromises);
  logger.info('Cleaned up channel state after bot removal', { avatarId, chatId });
}

/**
 * Register a home channel from the webhook handler.
 * This is a lightweight version that writes directly to ADMIN_TABLE.
 */
async function registerHomeChannelFromWebhook(
  avatarId: string,
  chatId: string,
  botUsername: string,
  channelUsername?: string,
  channelTitle?: string
): Promise<void> {
  if (!ADMIN_TABLE) return;

  const now = Date.now();

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: {
      pk: 'HOME_CHANNELS',
      sk: chatId,
      chatId,
      avatarId,
      botUsername,
      channelUsername,
      channelTitle,
      registeredAvatars: [{ avatarId, botUsername }],
      registeredAt: now,
      updatedAt: now,
    },
  }));
}

/**
 * Update avatar config with home channel info.
 * Uses UpdateCommand to only modify the home channel fields.
 */
async function updateAvatarHomeChannel(
  avatarId: string,
  chatId: string,
  channelUsername?: string,
  _channelTitle?: string // Unused but kept for potential future use
): Promise<void> {
  if (!STATE_TABLE) return;

  // Build the update expression dynamically
  const updateParts: string[] = [
    '#platforms.#telegram.#homeChannelId = :chatId',
  ];
  const expressionNames: Record<string, string> = {
    '#platforms': 'platforms',
    '#telegram': 'telegram',
    '#homeChannelId': 'homeChannelId',
  };
  const expressionValues: Record<string, unknown> = {
    ':chatId': chatId,
  };

  if (channelUsername) {
    updateParts.push('#platforms.#telegram.#homeChannelUsername = :username');
    expressionNames['#homeChannelUsername'] = 'homeChannelUsername';
    expressionValues[':username'] = channelUsername;

    // Also set the home channel URL
    updateParts.push('#platforms.#telegram.#homeChannelUrl = :url');
    expressionNames['#homeChannelUrl'] = 'homeChannelUrl';
    expressionValues[':url'] = `https://t.me/${channelUsername}`;
  }

  await dynamoClient.send(new UpdateCommand({
    TableName: STATE_TABLE,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: 'CONFIG',
    },
    UpdateExpression: `SET ${updateParts.join(', ')}`,
    ExpressionAttributeNames: expressionNames,
    ExpressionAttributeValues: expressionValues,
  }));

  // Invalidate the avatar config cache
  avatarConfigCache.delete(avatarId);
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
 * Checks if a chat ID is a registered home channel.
 */
function createHomeChannelChecker(): HomeChannelChecker {
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
 * For DMs (private chats): Uses allowedDmUserIds allowlist, or allowAllDms for admin bots.
 * For groups/channels: Uses home channel logic if homeChannelChecker is provided.
 *                      If allowedChatIds is configured, those chats are treated as home channels.
 *                      If homeChannelChecker is not provided, falls back to allowedChatIds allowlist.
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
  telegramCfg: {
    allowedChatIds?: string[];
    allowedChats?: Array<{ chatId: string }>;
    homeChannelId?: string;
    /** Allow all DMs (intended for admin/system bots only). */
    allowAllDms?: boolean;
    /** @deprecated Prefer allowedDmUsers for richer display info */
    allowedDmUserIds?: string[];
    allowedDmUsers?: Array<{ userId: string | number }>;
  } | undefined,
  homeChannelChecker?: HomeChannelChecker
): boolean | Promise<boolean> {
  const getAllowedChatIds = (): string[] | undefined => {
    // New format takes precedence if present (even if empty).
    if (telegramCfg && 'allowedChats' in telegramCfg) {
      return telegramCfg.allowedChats?.map((c) => String(c.chatId)) || [];
    }
    return telegramCfg?.allowedChatIds;
  };

  const getAllowedDmUserIds = (): string[] | undefined => {
    // New format takes precedence if present (even if empty).
    if (telegramCfg && 'allowedDmUsers' in telegramCfg) {
      return telegramCfg.allowedDmUsers?.map((u) => String(u.userId)) || [];
    }
    return telegramCfg?.allowedDmUserIds;
  };

  if (envelope.metadata.chatType === 'private') {
    if (telegramCfg?.allowAllDms) return true;

    const allowedDmUserIds = getAllowedDmUserIds();
    const senderId = String(envelope.sender.platformUserId ?? envelope.sender.id);

    if (!allowedDmUserIds || allowedDmUserIds.length === 0) {
      return false;
    }

    return allowedDmUserIds.includes(senderId);
  }

  // Groups/channels: use home channel logic if checker is provided
  if (homeChannelChecker) {
    const allowedChatIds = getAllowedChatIds();
    if (allowedChatIds && allowedChatIds.length > 0 && allowedChatIds.includes(envelope.conversationId)) {
      return true;
    }

    return homeChannelChecker.isHomeChannel(
      envelope.conversationId,
      telegramCfg?.homeChannelId
    );
  }

  // Fallback: optional allowlist by chat ID (legacy behavior)
  const allowedChatIds = getAllowedChatIds();
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

async function maybeBootstrapHomeChannelFromGroupEngagement(params: {
  avatarId: string;
  avatarConfig: AvatarConfig;
  envelope: {
    conversationId: string;
    metadata: {
      chatType?: string;
      chatTitle?: string;
      isMention?: boolean;
      isReplyToBot?: boolean;
    };
  };
}): Promise<boolean> {
  const { avatarId, avatarConfig, envelope } = params;

  if (!ADMIN_TABLE || !STATE_TABLE) return false;
  const chatType = envelope.metadata.chatType;
  if (chatType !== 'group' && chatType !== 'supergroup' && chatType !== 'channel') return false;

  const isEngaged = Boolean(envelope.metadata.isMention || envelope.metadata.isReplyToBot);
  if (!isEngaged) return false;

  const hasHomeChannel = Boolean(avatarConfig.platforms.telegram?.homeChannelId);
  if (hasHomeChannel) return false;

  const botUsername = avatarConfig.platforms.telegram?.botUsername || '';
  if (!botUsername) return false;

  try {
    await registerHomeChannelFromWebhook(
      avatarId,
      envelope.conversationId,
      botUsername,
      undefined,
      envelope.metadata.chatTitle
    );

    await updateAvatarHomeChannel(
      avatarId,
      envelope.conversationId,
      undefined,
      envelope.metadata.chatTitle
    );

    logger.info('Bootstrapped home channel from group engagement', {
      event: 'home_channel_bootstrapped',
      avatarId,
      chatId: envelope.conversationId,
      chatType,
    });
    return true;
  } catch (err) {
    logger.warn('Failed to bootstrap home channel from group engagement', {
      event: 'home_channel_bootstrap_failed',
      avatarId,
      chatId: envelope.conversationId,
      chatType,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
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

    let update: Record<string, unknown>;
    try {
      update = JSON.parse(body.toString()) as Record<string, unknown>;
    } catch (err) {
      logger.warn('Invalid JSON', { event: 'parse_error', error: err instanceof Error ? err.message : String(err) });
      return { statusCode: 400, body: 'Invalid JSON' };
    }

    // Handle bot added/removed from channel (my_chat_member update)
    if (update.my_chat_member) {
      const myChatMember = update.my_chat_member as {
        chat?: {
          id?: number;
          type?: string;
          username?: string;
          title?: string;
        };
        new_chat_member?: { status?: string };
      };
      const newStatus = myChatMember.new_chat_member?.status;
      const chatId = myChatMember.chat?.id;
      const chatUsername = myChatMember.chat?.username;
      const chatTitle = myChatMember.chat?.title;
      const chatType = myChatMember.chat?.type;

      // Bot was ADDED to a group/supergroup/channel
      if (chatId && (newStatus === 'member' || newStatus === 'administrator')) {
        // Only auto-register for groups, supergroups, channels (not private chats)
        if (chatType === 'group' || chatType === 'supergroup' || chatType === 'channel') {
          // Skip @ratibots (the default community channel)
          if (chatUsername?.toLowerCase() !== 'ratibots') {
            // Check if avatar already has a home channel configured
            const hasHomeChannel = Boolean(avatarConfig.platforms.telegram?.homeChannelId);

            if (!hasHomeChannel && ADMIN_TABLE) {
              try {
                // Register as home channel
                const botUsername = avatarConfig.platforms.telegram?.botUsername || '';
                await registerHomeChannelFromWebhook(
                  avatarId,
                  String(chatId),
                  botUsername,
                  chatUsername,
                  chatTitle
                );

                // Update avatar config with home channel info
                await updateAvatarHomeChannel(
                  avatarId,
                  String(chatId),
                  chatUsername,
                  chatTitle
                );

                logger.info('Auto-registered home channel', {
                  event: 'home_channel_auto_registered',
                  avatarId,
                  chatId: String(chatId),
                  chatUsername,
                  chatTitle,
                });
              } catch (err) {
                logger.warn('Failed to auto-register home channel', {
                  event: 'home_channel_auto_register_failed',
                  avatarId,
                  chatId: String(chatId),
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          }
        }
        return ok();
      }

      // Bot was REMOVED (left or kicked), clean up channel state
      if (chatId && (newStatus === 'left' || newStatus === 'kicked')) {
        logger.info('Bot removed from channel, cleaning up state', {
          event: 'bot_removed',
          chatId: String(chatId),
          newStatus,
        });
        await cleanupChannelState(avatarId, String(chatId));
        return ok();
      }
    }

    const telegramCfg = avatarConfig.platforms.telegram;

    // Handle callback_query updates (inline button presses) for DM bot creation flow
    if (update.callback_query) {
      logger.info('Callback query received', { event: 'callback_query' });
      try {
        const { processAdminCallbackQuery } = await import('./services/telegram-admin-handler.js');
        await processAdminCallbackQuery(avatarId, avatarConfig, update as unknown);
        return ok();
      } catch (err) {
        logger.error('Callback handler error', err, { event: 'callback_error' });
        return ok();
      }
    }

    const envelope = await telegramAdapter.parseMessage(update);
    if (!envelope) return ok();

    envelope.traceId = traceId;

    // Use home channel checker for groups/channels if ADMIN_TABLE is configured
    const homeChecker = ADMIN_TABLE ? createHomeChannelChecker() : undefined;
    // DMs: Route to admin service for bot creation/management flow
    // All bots can help users create their own bot
    if (envelope.metadata.chatType === 'private') {
      logger.info('DM received, routing to admin service', { event: 'dm_received', senderId: envelope.sender.id });

      // Idempotency check
      const isNewMessage = await stateService.checkAndSetIdempotency(envelope.metadata.idempotencyKey);
      if (!isNewMessage) {
        logger.info('Duplicate DM, skipping', { messageId: envelope.messageId });
        return ok();
      }

      try {
        const { processAdminMessage } = await import('./services/telegram-admin-handler.js');
        await processAdminMessage(avatarId, avatarConfig, envelope);
        logger.info('DM processed via admin service', {
          event: 'dm_processed',
          messageId: envelope.messageId,
          durationMs: Date.now() - startTime,
        });
        return ok();
      } catch (err) {
        logger.error('DM handler error', err, { event: 'dm_handler_error' });
        return ok();
      }
    }

    // Groups/channels: Check if chat is allowed (home channel registry)
    let chatAllowed = await Promise.resolve(isTelegramChatAllowed(envelope, telegramCfg, homeChecker));
    if (!chatAllowed) {
      const isMentioned = envelope.metadata.isMention || envelope.metadata.isReplyToBot;

      // Bots may already be in a group before we start receiving my_chat_member updates.
      // When directly engaged (mention/reply) and no home channel exists yet, bootstrap it.
      if (isMentioned) {
        const bootstrapped = await maybeBootstrapHomeChannelFromGroupEngagement({
          avatarId,
          avatarConfig,
          envelope,
        });
        if (bootstrapped) {
          chatAllowed = true;
        }
      }

      if (!chatAllowed) {
        logger.info('Chat not in home channel registry', { event: 'chat_blocked', chatId: envelope.conversationId });

        // Send redirect message if mentioned or replied to in non-home channel
        if (isMentioned) {
          try {
            const bot = telegramAdapter.getBot();
            if (bot) {
              const redirectMessage = buildRedirectMessage(telegramCfg);
              await bot.api.sendMessage(
                parseInt(envelope.conversationId),
                redirectMessage,
                { reply_to_message_id: parseInt(envelope.messageId) }
              );
              logger.info('Sent redirect message', {
                event: 'redirect_sent',
                chatId: envelope.conversationId,
              });
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

    // Note: DMs (private chats) are handled earlier and routed to admin service
    // This code path is only for groups/channels
    const normalizedChatType =
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
