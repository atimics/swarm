/**
 * @deprecated This handler is deprecated. Use @swarm/handlers telegram-webhook-shared.ts instead.
 *
 * The unified handlers/ package provides:
 * - Multi-tenant support via SQS queues
 * - Shared message-processor.ts for all platforms (Telegram, Twitter, Discord)
 * - Consistent behavior across platforms
 * - Better observability and scaling
 *
 * To migrate: Set enableSharedHandlers=true in CDK context (default for new deployments).
 * This file will be removed in a future version.
 *
 * Legacy Features (now in handlers/):
 * - Conversation history per chat (stored in DynamoDB)
 * - Tool support: image/video generation, wallet info, gallery
 * - Attention tracking for selective responses
 * - Media sending (photos, videos, stickers)
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import { isValidTelegramIP, getFileUrl as getTelegramFileUrl } from '../services/telegram.js';
import { timingSafeEqual } from 'crypto';
import * as channelState from '../services/channel-state.js';
import * as credits from '../services/credits.js';
import * as sharedChannel from '../services/shared-channel.js';
import * as initiative from '../services/initiative.js';
import { decideReaction } from '../services/reactions.js';
import { generateAvatarStats } from '../services/avatar-stats.js';
import type { AvatarRecord, SharedChannelRecord } from '../types.js';
import { extractThinking, logger } from '@swarm/core';
import type { ProcessorMessage } from '@swarm/core';
import { createTelegramProcessor } from '../services/processor-adapter.js';
import { recordError } from '../services/auto-issues.js';
import type { BufferedMessage, BufferedMedia, ChannelStateRecord } from '../types.js';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const secretsClient = new SecretsManagerClient({});

const ADMIN_TABLE = process.env.ADMIN_TABLE!;
const ENFORCE_IP_CHECK = process.env.ENFORCE_TELEGRAM_IP_CHECK !== 'false';
const INTERNAL_TEST_KEY = process.env.INTERNAL_TEST_KEY;
const DREAMS_ENABLED = process.env.DREAMS_ENABLED === 'true';
// === CONFIG ===
// NOTE: Channel-aware config is in services/channel-state.ts (CHANNEL_CONFIG)
const DEDUP_TTL_SECONDS = 300; // 5 minutes - prevent reprocessing same message on retries
const PROCESSING_TTL_SECONDS = 60; // 1 minute - allow retries after short processing failures
const TELEGRAM_TIMEOUT_MS = 10_000;
const TELEGRAM_RETRY_COUNT = 1;

// === SCHEMAS ===
const TelegramUserSchema = z.object({
  id: z.number(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  is_bot: z.boolean().optional(),
});

const TelegramChatSchema = z.object({
  id: z.number(),
  type: z.enum(['private', 'group', 'supergroup', 'channel']),
  title: z.string().optional(),
});

const TelegramMessageSchema = z.object({
  message_id: z.number(),
  from: TelegramUserSchema.optional(),
  chat: TelegramChatSchema,
  date: z.number(),
  text: z.string().optional(),
  caption: z.string().optional(),
  photo: z.unknown().optional(),
  video: z.unknown().optional(),
  animation: z.unknown().optional(),
  document: z.unknown().optional(),
  sticker: z.object({ emoji: z.string().optional() }).optional(),
  reply_to_message: z.object({
    message_id: z.number(),
    text: z.string().optional(),
    caption: z.string().optional(),
    from: z.object({ id: z.number(), username: z.string().optional() }).optional(),
  }).optional(),
});

const TelegramUpdateSchema = z.object({
  update_id: z.number(),
  message: TelegramMessageSchema.optional(),
  edited_message: TelegramMessageSchema.optional(),
  channel_post: TelegramMessageSchema.optional(),
  edited_channel_post: TelegramMessageSchema.optional(),
});

type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;

/**
 * Extract the message from a Telegram update.
 * Handles regular messages, edited messages, channel posts, and edited channel posts.
 * Priority: channel_post > edited_channel_post > message > edited_message
 */
function extractMessage(update: TelegramUpdate): TelegramUpdate['message'] | undefined {
  // Channel posts have priority over regular messages
  return update.channel_post || update.edited_channel_post || update.message || update.edited_message;
}

// Avatar config (internal use)
interface AvatarConfig {
  avatarId: string;
  name: string;
  persona?: string;
  platforms: {
    telegram?: { enabled: boolean; botUsername?: string; botId?: number };
    twitter?: { enabled: boolean };
  };
  llmConfig: { provider: string; model: string; temperature: number; maxTokens: number };
  wallets?: Array<{ name: string; publicKey: string }>;
  profileImage?: { url: string };
}


// === THINKING TAGS MEMORY STORAGE ===

/**
 * Save extracted thinking content to avatar's memory.
 * Thinking tags are internal reasoning that should persist but not be shown in chat.
 */
async function saveThinkingToMemory(
  avatarId: string,
  thinkingBlocks: string[],
  contextHint?: string
): Promise<void> {
  if (thinkingBlocks.length === 0) return;

  const now = Date.now();
  const ttl = Math.floor(now / 1000) + (90 * 24 * 60 * 60); // 90 days

  for (const thinking of thinkingBlocks) {
    // Create a deterministic ID from the thinking content for deduplication
    // Use TextEncoder to properly handle Unicode (including emojis)
    const encoder = new TextEncoder();
    const bytes = encoder.encode(thinking.slice(0, 100));
    const factId = Buffer.from(bytes)
      .toString('base64')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 20);
    
    const factWithContext = contextHint 
      ? `[Thinking in ${contextHint}]: ${thinking}`
      : `[Internal thought]: ${thinking}`;

    await dynamoClient.send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: {
        pk: `AVATAR#${avatarId}`,
        sk: `FACT#thinking#${factId}`,
        fact: factWithContext,
        about: 'thinking',
        timestamp: now,
        ttl,
      },
    }));
  }

  logger.info('Saved thinking blocks to memory', { count: thinkingBlocks.length, avatarId });
}

// === MCP TOOL CLIENT SETUP ===

// === CACHES ===
const secretsCache = new Map<string, string>();

// === FETCH HELPERS ===
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  retries: number
): Promise<Response> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= retries) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);
      if (response.ok) {
        return response;
      }

      const shouldRetry = response.status === 429 || response.status >= 500;
      if (!shouldRetry) {
        return response;
      }

      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    attempt += 1;
    if (attempt > retries) {
      break;
    }
    await sleep(250 * attempt);
  }

  throw lastError instanceof Error ? lastError : new Error('Fetch failed');
}

// === HELPER FUNCTIONS ===
async function getSecret(secretArn: string): Promise<string | null> {
  if (secretsCache.has(secretArn)) return secretsCache.get(secretArn)!;
  try {
    const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const value = response.SecretString || null;
    if (value) secretsCache.set(secretArn, value);
    return value;
  } catch (error) {
    logger.error('Failed to get secret', error);
    return null;
  }
}

async function getAvatarConfig(avatarId: string): Promise<AvatarConfig | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `AVATAR#${avatarId}`, sk: 'CONFIG' },
  }));
  if (!result.Item) return null;
  const config = result.Item as AvatarConfig;

  // Fetch wallets
  const walletsResult = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
    ExpressionAttributeValues: { ':pk': `AVATAR#${avatarId}`, ':sk': 'WALLET#' },
  }));
  if (walletsResult.Items?.length) {
    config.wallets = walletsResult.Items.map(w => ({ name: w.name, publicKey: w.publicKey }));
  }

  return config;
}

/**
 * Get full avatar record including createdAt (for D&D stats generation)
 */
async function getAvatarRecord(avatarId: string): Promise<AvatarRecord | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `AVATAR#${avatarId}`, sk: 'CONFIG' },
  }));
  return result.Item as AvatarRecord | null;
}

async function getTelegramToken(avatarId: string): Promise<string | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `AVATAR#${avatarId}`, sk: 'SECRET#telegram_bot_token#default' },
  }));
  if (!result.Item?.secretArn) return null;
  return getSecret(result.Item.secretArn);
}

async function getWebhookSecret(avatarId: string): Promise<string | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `AVATAR#${avatarId}`, sk: 'SECRET#telegram_webhook_secret#default' },
  }));
  if (!result.Item?.secretArn) return null;
  return getSecret(result.Item.secretArn);
}

// === MESSAGE DEDUPLICATION ===
// Prevents reprocessing the same message when Telegram retries due to Lambda timeout
// Handles stale "processing" markers from timed-out Lambda invocations
async function startMessageProcessing(avatarId: string, updateId: number): Promise<boolean> {
  const now = Date.now();
  const ttl = Math.floor(now / 1000) + PROCESSING_TTL_SECONDS;
  const pk = `TELEGRAM#${avatarId}`;
  const sk = `PROCESSED#${updateId}`;

  try {
    // Try to insert new processing marker
    await dynamoClient.send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: {
        pk,
        sk,
        status: 'processing',
        ttl,
        startedAt: now,
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
    return true;
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
      throw err;
    }

    // Record exists - check if it's stale or already processed
    const existing = await dynamoClient.send(new GetCommand({
      TableName: ADMIN_TABLE,
      Key: { pk, sk },
    }));

    if (!existing.Item) {
      // Race condition - record was deleted, try again
      return startMessageProcessing(avatarId, updateId);
    }

    const { status, startedAt } = existing.Item;

    // Already successfully processed - skip
    if (status === 'processed') {
      return false;
    }

    // Check if processing marker is stale (older than PROCESSING_TTL_SECONDS)
    const staleThreshold = now - (PROCESSING_TTL_SECONDS * 1000);
    if (status === 'processing' && startedAt && startedAt < staleThreshold) {
      logger.info('Taking over stale processing marker', { staleDurationSeconds: Math.round((now - startedAt) / 1000) });
      // Take over the stale processing marker
      try {
        await dynamoClient.send(new UpdateCommand({
          TableName: ADMIN_TABLE,
          Key: { pk, sk },
          UpdateExpression: 'SET startedAt = :startedAt, #ttl = :ttl',
          ConditionExpression: '#status = :processing AND startedAt = :oldStartedAt',
          ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':startedAt': now,
            ':ttl': ttl,
            ':processing': 'processing',
            ':oldStartedAt': startedAt,
          },
        }));
        return true;
      } catch (updateErr: unknown) {
        if ((updateErr as { name?: string }).name === 'ConditionalCheckFailedException') {
          // Another process took over - skip
          return false;
        }
        throw updateErr;
      }
    }

    // Processing marker is fresh - another Lambda is handling it
    return false;
  }
}

async function markMessageProcessed(avatarId: string, updateId: number): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + DEDUP_TTL_SECONDS;
  try {
    await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: { pk: `TELEGRAM#${avatarId}`, sk: `PROCESSED#${updateId}` },
      UpdateExpression: 'SET #status = :status, processedAt = :processedAt, #ttl = :ttl',
      ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':status': 'processed',
        ':processedAt': Date.now(),
        ':ttl': ttl,
      },
    }));
  } catch (err) {
    logger.warn('Failed to mark message as processed', { error: err });
  }
}

async function clearMessageProcessing(avatarId: string, updateId: number): Promise<void> {
  try {
    await dynamoClient.send(new DeleteCommand({
      TableName: ADMIN_TABLE,
      Key: { pk: `TELEGRAM#${avatarId}`, sk: `PROCESSED#${updateId}` },
    }));
  } catch (err) {
    logger.warn('Failed to clear message processing marker', { error: err });
  }
}

// === TELEGRAM API ===
function escapeTelegramMarkdownV2(text: string): string {
  // eslint-disable-next-line no-useless-escape
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

async function sendTelegramMessage(
  token: string,
  avatarId: string,
  chatId: number,
  text: string,
  replyTo?: number,
  options?: {
    parseMode?: 'MarkdownV2' | 'HTML' | undefined;
    disableWebPagePreview?: boolean;
  }
): Promise<number | null> {
  const canUse = await credits.canUseTool(avatarId, 'send_message');
  if (!canUse.allowed) {
    logger.warn('send_message rate limit hit', { avatarId, reason: canUse.reason });
    return null;
  }

  try {
    const parseMode = options?.parseMode ?? 'MarkdownV2';
    const safeText = parseMode === 'MarkdownV2' ? escapeTelegramMarkdownV2(text) : text;
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: safeText,
      reply_to_message_id: replyTo,
      disable_web_page_preview: options?.disableWebPagePreview,
    };
    if (parseMode) {
      payload.parse_mode = parseMode;
    }

    const response = await fetchWithRetry(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
        }),
      },
      TELEGRAM_TIMEOUT_MS,
      TELEGRAM_RETRY_COUNT
    );
    if (!response.ok) {
      logger.error('Telegram sendMessage error', undefined, { responseText: await response.text() });
      return null;
    }
    await credits.consumeCredit(avatarId, 'send_message');
    const data = await response.json() as { result?: { message_id: number } };
    return data.result?.message_id || null;
  } catch (error) {
    logger.error('Telegram sendMessage failed', error);
    return null;
  }
}

async function sendTelegramPhoto(token: string, chatId: number, photoUrl: string, caption?: string, replyTo?: number): Promise<void> {
  logger.info('Sending photo to chat', { chatId, photoUrlPreview: photoUrl.slice(0, 80) });

  // Download the image first, then send as buffer
  // This is more reliable than letting Telegram fetch the URL (which may be private S3)
  // Same approach as solanafirehorse implementation
  try {
    const imageResponse = await fetchWithRetry(
      photoUrl,
      { method: 'GET' },
      TELEGRAM_TIMEOUT_MS,
      TELEGRAM_RETRY_COUNT
    );
    if (!imageResponse.ok) {
      logger.error('Failed to download image', undefined, { status: imageResponse.status });
      // Fall back to URL-based send (might work for public CDN URLs)
      try {
        const response = await fetchWithRetry(
          `https://api.telegram.org/bot${token}/sendPhoto`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              photo: photoUrl,
              caption: caption ? escapeTelegramMarkdownV2(caption.slice(0, 1024)) : undefined,
              parse_mode: 'MarkdownV2',
              reply_to_message_id: replyTo,
            }),
          },
          TELEGRAM_TIMEOUT_MS,
          TELEGRAM_RETRY_COUNT
        );
        if (!response.ok) {
          logger.error('sendPhoto (URL fallback) failed', undefined, { status: response.status, responseText: await response.text() });
        }
      } catch (error) {
        logger.error('sendPhoto (URL fallback) failed', error);
      }
      return;
    }

    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    logger.info('Downloaded image, sending as buffer', { byteCount: imageBuffer.length });

    // Use native FormData (Node.js 18+) with Blob
    const form = new FormData();
    form.append('chat_id', chatId.toString());
    form.append('photo', new Blob([imageBuffer], { type: 'image/png' }), 'image.png');
    if (caption) {
      form.append('caption', escapeTelegramMarkdownV2(caption.slice(0, 1024)));
      form.append('parse_mode', 'MarkdownV2');
    }
    if (replyTo) {
      form.append('reply_to_message_id', replyTo.toString());
    }

    const response = await fetchWithRetry(
      `https://api.telegram.org/bot${token}/sendPhoto`,
      {
        method: 'POST',
        body: form,
      },
      TELEGRAM_TIMEOUT_MS,
      TELEGRAM_RETRY_COUNT
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('sendPhoto (buffer) failed', undefined, { status: response.status, errorText });
    } else {
      logger.info('Photo sent successfully', { chatId });
    }
  } catch (err) {
    logger.error('Error sending photo', err);
  }
}

async function sendTelegramVideo(token: string, chatId: number, videoUrl: string, caption?: string, replyTo?: number): Promise<void> {
  logger.info('Sending video to chat', { chatId, videoUrlPreview: videoUrl.slice(0, 80) });

  // Download the video first, then send as buffer
  // This is more reliable than letting Telegram fetch the URL (which may be private S3)
  // Same approach as photo sending
  try {
    const videoResponse = await fetchWithRetry(
      videoUrl,
      { method: 'GET' },
      TELEGRAM_TIMEOUT_MS * 2, // Videos may be larger, give more time
      TELEGRAM_RETRY_COUNT
    );
    if (!videoResponse.ok) {
      logger.error('Failed to download video', undefined, { status: videoResponse.status });
      // Fall back to URL-based send (might work for public CDN URLs)
      try {
        const response = await fetchWithRetry(
          `https://api.telegram.org/bot${token}/sendVideo`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              video: videoUrl,
              caption: caption ? escapeTelegramMarkdownV2(caption.slice(0, 1024)) : undefined,
              parse_mode: 'MarkdownV2',
              reply_to_message_id: replyTo,
            }),
          },
          TELEGRAM_TIMEOUT_MS,
          TELEGRAM_RETRY_COUNT
        );
        if (!response.ok) {
          logger.error('sendVideo (URL fallback) failed', undefined, { status: response.status, responseText: await response.text() });
        }
      } catch (error) {
        logger.error('sendVideo (URL fallback) failed', error);
      }
      return;
    }

    const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
    logger.info('Downloaded video, sending as buffer', { byteCount: videoBuffer.length });

    // Use native FormData (Node.js 18+) with Blob
    const form = new FormData();
    form.append('chat_id', chatId.toString());
    form.append('video', new Blob([videoBuffer], { type: 'video/mp4' }), 'video.mp4');
    if (caption) {
      form.append('caption', escapeTelegramMarkdownV2(caption.slice(0, 1024)));
      form.append('parse_mode', 'MarkdownV2');
    }
    if (replyTo) {
      form.append('reply_to_message_id', replyTo.toString());
    }

    const response = await fetchWithRetry(
      `https://api.telegram.org/bot${token}/sendVideo`,
      {
        method: 'POST',
        body: form,
      },
      TELEGRAM_TIMEOUT_MS * 2, // Videos may be larger
      TELEGRAM_RETRY_COUNT
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('sendVideo (buffer) failed', undefined, { status: response.status, errorText });
    } else {
      logger.info('Video sent successfully', { chatId });
    }
  } catch (err) {
    logger.error('Error sending video', err);
  }
}

/**
 * Send a sticker to Telegram chat
 * Telegram supports .webp (static), .tgs (animated), .webm (video sticker) formats
 * Note: sendSticker does NOT support captions
 */
async function sendTelegramSticker(token: string, chatId: number, stickerUrl: string, replyTo?: number): Promise<void> {
  logger.info('Sending sticker to chat', { chatId, stickerUrlPreview: stickerUrl.slice(0, 80) });

  try {
    // Download the sticker first, then send as buffer
    const stickerResponse = await fetchWithRetry(
      stickerUrl,
      { method: 'GET' },
      TELEGRAM_TIMEOUT_MS,
      TELEGRAM_RETRY_COUNT
    );
    if (!stickerResponse.ok) {
      logger.error('Failed to download sticker', undefined, { status: stickerResponse.status });
      // Fall back to URL-based send
      try {
        const response = await fetchWithRetry(
          `https://api.telegram.org/bot${token}/sendSticker`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              sticker: stickerUrl,
              reply_to_message_id: replyTo,
            }),
          },
          TELEGRAM_TIMEOUT_MS,
          TELEGRAM_RETRY_COUNT
        );
        if (!response.ok) {
          logger.error('sendSticker (URL fallback) failed', undefined, { status: response.status, responseText: await response.text() });
        }
      } catch (error) {
        logger.error('sendSticker (URL fallback) failed', error);
      }
      return;
    }

    const stickerBuffer = Buffer.from(await stickerResponse.arrayBuffer());
    logger.info('Downloaded sticker, sending as buffer', { byteCount: stickerBuffer.length });

    // Determine content type from URL extension
    const isWebm = /\.webm(\?.*)?$/i.test(stickerUrl);
    const isTgs = /\.tgs(\?.*)?$/i.test(stickerUrl);
    const contentType = isWebm ? 'video/webm' : isTgs ? 'application/gzip' : 'image/webp';
    const filename = isWebm ? 'sticker.webm' : isTgs ? 'sticker.tgs' : 'sticker.webp';

    // Use native FormData (Node.js 18+) with Blob
    const form = new FormData();
    form.append('chat_id', chatId.toString());
    form.append('sticker', new Blob([stickerBuffer], { type: contentType }), filename);
    if (replyTo) {
      form.append('reply_to_message_id', replyTo.toString());
    }

    const response = await fetchWithRetry(
      `https://api.telegram.org/bot${token}/sendSticker`,
      {
        method: 'POST',
        body: form,
      },
      TELEGRAM_TIMEOUT_MS,
      TELEGRAM_RETRY_COUNT
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('sendSticker (buffer) failed', undefined, { status: response.status, errorText });
    } else {
      logger.info('Sticker sent successfully', { chatId });
    }
  } catch (err) {
    logger.error('Error sending sticker', err);
  }
}

/**
 * Send sticker or photo based on file format
 * Uses sendSticker for .webp/.tgs/.webm formats, falls back to sendPhoto for others (e.g., PNG)
 * Since Telegram stickers don't support captions, sends caption as separate message if needed
 */
async function sendTelegramStickerOrPhoto(
  token: string,
  avatarId: string,
  chatId: number,
  mediaUrl: string,
  caption?: string,
  replyTo?: number
): Promise<void> {
  const isStickerFormat = /\.(webp|tgs|webm)(\?.*)?$/i.test(mediaUrl);

  if (isStickerFormat) {
    await sendTelegramSticker(token, chatId, mediaUrl, replyTo);
    // Telegram stickers don't support captions, send as separate message
    if (caption) {
      await sendTelegramMessage(token, avatarId, chatId, caption);
    }
    return;
  }

  // Non-sticker format (e.g., PNG) - send as photo
  logger.info('Sticker URL is not a sticker format, sending as photo', { mediaUrlPreview: mediaUrl.slice(0, 60) });
  await sendTelegramPhoto(token, chatId, mediaUrl, caption, replyTo);
}

async function sendChatAction(token: string, chatId: number, action: string): Promise<void> {
  try {
    await fetchWithRetry(
      `https://api.telegram.org/bot${token}/sendChatAction`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action }),
      },
      TELEGRAM_TIMEOUT_MS,
      TELEGRAM_RETRY_COUNT
    );
  } catch (error) {
    logger.warn('Telegram sendChatAction failed', { error });
  }
}


/**
 * Fetch image URLs from buffered messages that have photos
 * Returns a map of messageId -> imageUrl for recent messages with photos
 */
async function fetchImageUrlsFromBuffer(
  token: string,
  messages: BufferedMessage[],
  maxImages: number = 3
): Promise<Map<number, string>> {
  const imageUrls = new Map<number, string>();
  
  // Get recent messages with photos (most recent first)
  const messagesWithPhotos = [...messages]
    .reverse()
    .filter(m => m.media?.some(media => media.type === 'photo'))
    .slice(0, maxImages);
  
  // Fetch URLs in parallel
  await Promise.all(
    messagesWithPhotos.map(async (msg) => {
      const photo = msg.media?.find(m => m.type === 'photo');
      if (!photo) return;
      
      try {
        const url = await getTelegramFileUrl(token, photo.fileId);
        if (url) {
          imageUrls.set(msg.messageId, url);
        }
      } catch (error) {
        logger.warn('Failed to get file URL for message', { messageId: msg.messageId, error });
      }
    })
  );
  
  return imageUrls;
}

// === CHANNEL-AWARE PROCESSING ===

/**
 * Process a message using channel-aware architecture
 * - Buffers message in channel state
 * - Evaluates if response should be triggered
 * - Responds to CHANNEL with full context (not individual messages)
 */
async function processChannelMessage(
  avatarId: string,
  avatar: AvatarConfig,
  message: NonNullable<TelegramUpdate['message']>,
  token: string
): Promise<{ responded: boolean; reason: string }> {
  const chatId = message.chat.id;
  const chatType = message.chat.type;
  const messageId = message.message_id;
  const text = message.text || message.caption || '';
  const hasMedia = Boolean(
    message.photo ||
    message.video ||
    message.animation ||
    message.document ||
    message.sticker
  );
  const contentText = text || (hasMedia ? '[media]' : '');
  const userId = message.from?.id || 0;
  const userName = message.from?.first_name || 'User';
  const username = message.from?.username;
  const botUsername = avatar.platforms.telegram?.botUsername;
  const botId = avatar.platforms.telegram?.botId;
  const isFromBot = message.from?.is_bot === true;
  const senderBotUsername = isFromBot ? message.from?.username : undefined;

  // Extract media attachments
  const media: BufferedMedia[] = [];
  if (message.photo) {
    // Telegram sends multiple sizes, pick the largest
    const photos = message.photo as Array<{ file_id: string; file_unique_id: string; width: number; height: number }>;
    const largest = photos.reduce((max, p) => (p.width * p.height > max.width * max.height ? p : max), photos[0]);
    if (largest) {
      media.push({ type: 'photo', fileId: largest.file_id });
    }
  }
  if (message.video) {
    const video = message.video as { file_id: string; mime_type?: string };
    media.push({ type: 'video', fileId: video.file_id, mimeType: video.mime_type });
  }
  if (message.animation) {
    const animation = message.animation as { file_id: string; mime_type?: string };
    media.push({ type: 'animation', fileId: animation.file_id, mimeType: animation.mime_type });
  }
  if (message.document) {
    const doc = message.document as { file_id: string; mime_type?: string };
    media.push({ type: 'document', fileId: doc.file_id, mimeType: doc.mime_type });
  }
  if (message.sticker) {
    const sticker = message.sticker as { file_id: string; emoji?: string };
    media.push({ type: 'sticker', fileId: sticker.file_id });
  }

  // Check if this is a mention or reply to bot
  const isMention = botUsername ? new RegExp(`@${botUsername}\\b`, 'i').test(text) : false;
  const replyFromId = message.reply_to_message?.from?.id;
  const replyFromUsername = message.reply_to_message?.from?.username;
  const isReplyToBot = Boolean(
    (typeof botId === 'number' && typeof replyFromId === 'number' && replyFromId === botId) ||
    (botUsername && replyFromUsername && replyFromUsername.toLowerCase() === botUsername.toLowerCase())
  );

  // Create buffered message
  const replyToText = message.reply_to_message?.text || message.reply_to_message?.caption;

  const bufferedMessage: BufferedMessage = {
    messageId,
    userId,
    userName,
    username,
    text: contentText,
    timestamp: Date.now(),
    replyToMessageId: message.reply_to_message?.message_id,
    replyToUserId: message.reply_to_message?.from?.id,
    replyToUserName: message.reply_to_message?.from?.username,
    replyToUsername: message.reply_to_message?.from?.username,
    replyToText: replyToText || undefined,
    isMention,
    isReplyToBot,
    media: media.length > 0 ? media : undefined,
    isFromBot,
    senderBotUsername,
  };

  // Add message to buffer and get updated state
  const updatedState = await channelState.addMessageToBuffer(
    avatarId,
    chatId,
    chatType,
    message.chat.title,
    bufferedMessage
  );

  logger.info('Channel state', {
    avatarId,
    chatId,
    chatType,
    state: updatedState.state,
    bufferSize: updatedState.bufferSize,
    isMention,
    isReplyToBot,
  });

  // Evaluate if we should respond
  const decision = channelState.evaluateResponseTrigger(updatedState, botUsername, botId);

  logger.info('Response decision', {
    chatId,
    shouldRespond: decision.shouldRespond,
    trigger: decision.trigger,
    delay: decision.delay,
    priority: decision.priority,
  });

  if (!decision.shouldRespond) {
    return { responded: false, reason: `no_trigger:${updatedState.state}` };
  }

  // Apply delay if specified (makes responses feel more natural)
  if (decision.delay > 0) {
    await new Promise(resolve => setTimeout(resolve, decision.delay));
  }

  // Transition to ACTIVE state
  await channelState.transitionState(avatarId, chatId, 'ACTIVE');

  // Process and respond to the channel using unified MessageProcessor
  const responseMessageId = await processChannelResponse(
    avatarId,
    avatar,
    updatedState,
    token,
    decision.trigger,
    botUsername
  );

  if (responseMessageId) {
    // Mark response sent and transition to COOLDOWN
    await channelState.markResponseSent(avatarId, chatId, responseMessageId, { trigger: decision.trigger });
    return { responded: true, reason: decision.trigger };
  }

  return { responded: false, reason: 'response_failed' };
}

/**
 * Generate and send response to the channel using unified MessageProcessor.
 * Uses the same tool filtering and prompt building as the admin UI,
 * ensuring consistent behavior across all platforms.
 */
async function processChannelResponse(
  avatarId: string,
  _avatar: AvatarConfig, // Unused - MessageProcessor loads avatar config internally
  state: ChannelStateRecord,
  token: string,
  trigger: string,
  botUsername?: string
): Promise<number | null> {
  const chatId = state.chatId;
  const isMultiAgent = state.chatType !== 'private';

  // Build conversation context (same as before - this is Telegram-specific)
  let conversationContext: string;
  if (isMultiAgent) {
    const sharedHistory = await channelState.getSharedHistory(chatId);
    conversationContext = channelState.buildCombinedConversationContext(state, sharedHistory, avatarId);
  } else {
    conversationContext = channelState.buildConversationContext(state);
  }

  // Fetch image URLs from recent messages (for vision)
  const imageUrlMap = await fetchImageUrlsFromBuffer(token, state.messageBuffer, 3);
  const recentImageUrls = Array.from(imageUrlMap.values());

  // Convert conversation context to ProcessorMessage format
  const conversationHistory: ProcessorMessage[] = [];

  // Add context as a user message with the conversation history
  const contextMessage = conversationContext
    ? `Here's the recent conversation:\n\n${conversationContext}\n\nRespond naturally in 1-2 sentences. Be brief!`
    : 'Start a conversation!';

  // Build attachments for vision
  const attachments = recentImageUrls.map(url => ({
    type: 'image' as const,
    data: url,
  }));

  // Get response target for reply
  const responseTarget = channelState.getResponseTarget(state);
  const replyToMessageId = responseTarget?.messageId;

  // Create the unified processor
  const processor = createTelegramProcessor();

  // Process the message
  logger.info('Using unified MessageProcessor for Telegram response', {
    avatarId,
    chatId,
    trigger,
    hasImages: recentImageUrls.length > 0,
  });

  const result = await processor.process(
    contextMessage,
    conversationHistory,
    {
      avatarId,
      platform: 'telegram',
      conversationId: String(chatId),
      userId: responseTarget?.userId ? String(responseTarget.userId) : undefined,
      replyToMessageId: replyToMessageId ? String(replyToMessageId) : undefined,
    },
    {
      attachments: attachments.length > 0 ? attachments : undefined,
      dreamsEnabled: DREAMS_ENABLED,
    }
  );

  let responseMessageId: number | null = null;
  let finalResponseContent: string | null = null;

  // Send typing indicator
  await sendChatAction(token, chatId, 'typing');

  // Extract thinking tags from response (if any)
  if (result.response) {
    const { cleanContent, thinkingBlocks, hasThinking } = extractThinking(result.response);

    if (hasThinking) {
      // Save thinking to avatar's memory (async, don't block response)
      saveThinkingToMemory(avatarId, thinkingBlocks, `chat ${chatId}`).catch(err => {
        logger.error('Failed to save thinking to memory', err);
      });
    }

    // Send clean content to chat
    if (cleanContent) {
      responseMessageId = await sendTelegramMessage(token, avatarId, chatId, cleanContent, replyToMessageId);
      finalResponseContent = cleanContent;
    }
  }

  // Send media
  if (result.media) {
    for (const m of result.media) {
      if (m.type === 'image') {
        await sendTelegramPhoto(token, chatId, m.url, m.caption);
      } else if (m.type === 'video') {
        await sendTelegramVideo(token, chatId, m.url, m.caption);
      } else if (m.type === 'sticker') {
        await sendTelegramStickerOrPhoto(token, avatarId, chatId, m.url, m.caption);
      }
    }
  }

  // Record bot's message to shared history for multi-avatar visibility
  if (responseMessageId && finalResponseContent && isMultiAgent && botUsername) {
    await channelState.recordBotMessage(chatId, {
      messageId: responseMessageId,
      avatarId,
      botUsername,
      text: finalResponseContent,
      timestamp: Date.now(),
      replyToMessageId,
    });
  }

  return responseMessageId;
}

// === MULTI-AGENT COORDINATION ===

/**
 * Handle message in a multi-avatar channel using D&D-style initiative.
 *
 * Flow:
 * 1. Check interest (CHA/WIS roll)
 * 2. Roll initiative (1d20 + DEX)
 * 3. Winner responds, others can react
 *
 * Note: Avatar is already registered in shared channel by caller.
 */
async function handleMultiAvatarMessage(
  avatarId: string,
  avatar: AvatarConfig,
  avatarRecord: AvatarRecord,
  message: NonNullable<TelegramUpdate['message']>,
  token: string,
  _channelAvatars: SharedChannelRecord[]
): Promise<{ responded: boolean; reason: string }> {
  const chatId = message.chat.id;
  const chatType = message.chat.type;
  const messageId = message.message_id;
  const text = message.text || message.caption || '';
  const botUsername = avatar.platforms.telegram?.botUsername;

  // Extract media attachments (same as processChannelMessage)
  const msgMedia: BufferedMedia[] = [];
  if (message.photo) {
    const photos = message.photo as Array<{ file_id: string; file_unique_id: string; width: number; height: number }>;
    const largest = photos.reduce((max, p) => (p.width * p.height > max.width * max.height ? p : max), photos[0]);
    if (largest) {
      msgMedia.push({ type: 'photo', fileId: largest.file_id });
    }
  }
  if (message.video) {
    const video = message.video as { file_id: string; mime_type?: string };
    msgMedia.push({ type: 'video', fileId: video.file_id, mimeType: video.mime_type });
  }
  if (message.animation) {
    const animation = message.animation as { file_id: string; mime_type?: string };
    msgMedia.push({ type: 'animation', fileId: animation.file_id, mimeType: animation.mime_type });
  }
  if (message.document) {
    const doc = message.document as { file_id: string; mime_type?: string };
    msgMedia.push({ type: 'document', fileId: doc.file_id, mimeType: doc.mime_type });
  }
  if (message.sticker) {
    const sticker = message.sticker as { file_id: string; emoji?: string };
    msgMedia.push({ type: 'sticker', fileId: sticker.file_id });
  }

  // Get or generate avatar stats
  const stats = generateAvatarStats(avatarRecord.createdAt, avatarId);

  // Get channel state for activity metrics
  const state = await channelState.getOrCreateChannelState(
    avatarId,
    chatId,
    chatType,
    message.chat.title
  );

  // Calculate recent response age
  const recentResponseAge = state.lastResponseAt
    ? Date.now() - state.lastResponseAt
    : null;

  // Check if message is from a bot (for bot-to-bot interaction handling)
  const isFromBot = message.from?.is_bot === true;
  const senderBotUsername = isFromBot ? message.from?.username : undefined;
  
  // Calculate time since last bot response (for rate limiting bot interactions)
  const lastBotResponseAge = state.lastBotResponseAt
    ? Date.now() - state.lastBotResponseAt
    : null;

  // Create buffered message for interest check
  const replyToText = message.reply_to_message?.text || message.reply_to_message?.caption;
  const bufferedMessage: BufferedMessage = {
    messageId,
    userId: message.from?.id || 0,
    userName: message.from?.first_name || 'User',
    username: message.from?.username,
    text,
    timestamp: Date.now(),
    replyToMessageId: message.reply_to_message?.message_id,
    replyToUserId: message.reply_to_message?.from?.id,
    replyToUserName: message.reply_to_message?.from?.username,
    replyToUsername: message.reply_to_message?.from?.username,
    replyToText: replyToText || undefined,
    isMention: false, // Already handled direct mentions before this
    isReplyToBot: false,
    media: msgMedia.length > 0 ? msgMedia : undefined,
    // Bot-to-bot interaction tracking
    isFromBot,
    senderBotUsername,
  };

  // Add message to buffer (needed for context)
  await channelState.addMessageToBuffer(
    avatarId,
    chatId,
    chatType,
    message.chat.title,
    bufferedMessage
  );

  // Coordinate initiative with error handling (includes bot interaction awareness)
  let initiativeResult: initiative.InitiativeResult;
  try {
    initiativeResult = await initiative.coordinateInitiative(
      chatId,
      messageId,
      avatarId,
      stats,
      bufferedMessage,
      recentResponseAge,
      state.bufferSize,
      lastBotResponseAge  // Pass bot response age for rate limiting
    );
  } catch (err) {
    // On initiative coordination failure, skip to avoid blocking the webhook
    logger.error('Initiative coordination failed, skipping', err);
    return { responded: false, reason: 'initiative_error' };
  }

  logger.info('Multi-avatar initiative result', {
    avatarId,
    chatId,
    messageId,
    action: initiativeResult.action,
    reason: initiativeResult.reason,
    myRoll: initiativeResult.myRoll,
    winnerId: initiativeResult.winnerId,
    winnerRoll: initiativeResult.winnerRoll,
    isFromBot,
  });

  switch (initiativeResult.action) {
    case 'respond': {
      // This avatar won initiative - send full response
      const updatedState = await channelState.getChannelState(avatarId, chatId);
      if (!updatedState) {
        return { responded: false, reason: 'state_not_found' };
      }
      
      // Calculate a natural thinking delay for cosy pacing
      const thinkingDelay = channelState.calculateThinkingDelay(
        text.length,
        isFromBot,
        _channelAvatars.length
      );
      
      if (thinkingDelay > 0) {
        logger.info('Waiting for cosy response delay', {
          delayMs: thinkingDelay,
          isFromBot,
          avatarCount: _channelAvatars.length
        });
        await new Promise(resolve => setTimeout(resolve, thinkingDelay));
      }

      // Process and respond using unified MessageProcessor
      const responseMessageId = await processChannelResponse(
        avatarId,
        avatar,
        updatedState,
        token,
        'initiative_winner',
        botUsername
      );

      if (responseMessageId) {
        // Track if we responded to a bot message (for bot-to-bot rate limiting)
        await channelState.markResponseSent(
          avatarId, 
          chatId, 
          responseMessageId,
          { trigger: 'initiative_winner', respondedToBotUsername: isFromBot ? senderBotUsername : undefined }
        );
        // Mark that winner responded (for reaction coordination)
        await initiative.markWinnerResponded(chatId, messageId);
        return { responded: true, reason: 'initiative_winner' };
      }
      return { responded: false, reason: 'response_failed' };
    }

    case 'react': {
      // Lost initiative: may react, but coordinate/cap reactions per message.
      const reaction = decideReaction(text);
      if (!reaction.shouldReact || !reaction.emoji) {
        return { responded: false, reason: 'lost_initiative_no_reaction' };
      }

      const maxReactions = channelState.MULTI_AGENT_CONFIG.MAX_REACTIONS_PER_MESSAGE;
      const claimed = await initiative.tryClaimReactionSlot(chatId, messageId, avatarId, maxReactions);
      if (!claimed) {
        return { responded: false, reason: 'lost_initiative_reaction_capped' };
      }

      const delayMs = Math.min(Math.max(reaction.delay, 0), 15000);
      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      try {
        await fetchWithRetry(
          `https://api.telegram.org/bot${token}/setMessageReaction`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              message_id: messageId,
              reaction: [{ type: 'emoji', emoji: reaction.emoji }],
            }),
          },
          TELEGRAM_TIMEOUT_MS,
          TELEGRAM_RETRY_COUNT
        );

        logger.info('Sent reaction after losing initiative', {
          avatarId,
          chatId,
          messageId,
          emoji: reaction.emoji,
          isFromBot,
        });
        return { responded: false, reason: 'lost_initiative_reacted' };
      } catch (err) {
        logger.warn('Failed to send reaction', { avatarId, chatId, messageId, error: err });
        return { responded: false, reason: 'lost_initiative_reaction_failed' };
      }
    }

    case 'skip':
    default:
      return { responded: false, reason: initiativeResult.reason };
  }
}

/**
 * Check if a specific bot is mentioned in the message text.
 */
function isBotMentioned(text: string, botUsername: string | undefined): boolean {
  if (!botUsername) return false;
  return new RegExp(`@${botUsername}\\b`, 'i').test(text);
}

// === SECURITY ===
function verifySecretToken(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

function getClientIP(event: APIGatewayProxyEventV2): string | null {
  return event.headers['cf-connecting-ip'] ||
    event.headers['x-forwarded-for']?.split(',')[0].trim() ||
    event.requestContext.http.sourceIp || null;
}

// === HANDLER ===
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const avatarId = event.pathParameters?.avatarId;
  const clientIP = getClientIP(event);
  const requestId = event.requestContext.requestId;

  // Structured log for request entry - queryable by /logs API
  logger.setContext({ subsystem: 'telegram', avatarId, requestId });
  logger.info('Request received', {
    event: 'request_received',
    clientIP,
    method: event.requestContext.http.method,
  });

  const ok = () => ({ statusCode: 200, body: 'OK' });

  try {
    if (!avatarId || !/^[a-zA-Z0-9_-]+$/.test(avatarId)) {
      logger.warn('Invalid avatar ID');
      return ok();
    }

    // Allow internal test key to bypass IP check (for E2E tests)
    const internalTestKey = event.headers['x-internal-test-key'];
    const isInternalTest = INTERNAL_TEST_KEY && internalTestKey === INTERNAL_TEST_KEY;

    if (ENFORCE_IP_CHECK && !isInternalTest) {
      if (!clientIP || !isValidTelegramIP(clientIP)) {
        logger.warn('Rejecting non-Telegram IP', { clientIP: clientIP || 'unknown' });
        return { statusCode: 403, body: 'Forbidden' };
      }
    }

    // Verify webhook secret
    const webhookSecret = await getWebhookSecret(avatarId);
    const providedSecret = event.headers['x-telegram-bot-api-secret-token'];
    if (webhookSecret && !verifySecretToken(providedSecret, webhookSecret)) {
      logger.warn('Invalid secret for avatar', { avatarId });
      return ok();
    }

    // Load avatar
    const avatar = await getAvatarConfig(avatarId);
    if (!avatar || !avatar.platforms.telegram?.enabled) {
      logger.warn('Avatar not found or Telegram disabled', { avatarId });
      return ok();
    }

    // Get token
    const token = await getTelegramToken(avatarId);
    if (!token) {
      logger.error('No Telegram token', undefined, { avatarId });
      return ok();
    }

    // Parse and validate update
    const parseResult = TelegramUpdateSchema.safeParse(
      event.body ? JSON.parse(event.body) : {}
    );
    if (!parseResult.success) {
      logger.warn('Invalid Telegram update', { error: parseResult.error.message });
      return ok();
    }
    const update = parseResult.data;
    const message = extractMessage(update);
    if (!message) return ok();

    // Check if this is a channel post (for logging)
    const isChannelPost = Boolean(update.channel_post || update.edited_channel_post);

    const hasContent = Boolean(
      message.text ||
      message.caption ||
      message.photo ||
      message.video ||
      message.animation ||
      message.document ||
      message.sticker
    );
    if (!hasContent) return ok();

    // Best-effort breadcrumb for diagnostics.
    try {
      const snapshot = {
        receivedAt: Date.now(),
        updateId: update.update_id,
        chatId: message.chat.id,
        chatType: message.chat.type,
        fromUserId: message.from?.id,
        messageId: message.message_id,
        textPreview:
          typeof message.text === 'string'
            ? message.text.slice(0, 160)
            : typeof message.caption === 'string'
              ? message.caption.slice(0, 160)
              : undefined,
      };

      await dynamoClient.send(new PutCommand({
        TableName: ADMIN_TABLE,
        Item: {
          pk: `AVATAR#${avatarId}`,
          sk: 'TELEGRAM#LAST_UPDATE',
          snapshot,
          updatedAt: new Date().toISOString(),
        },
      }));
    } catch (error) {
      logger.warn('Failed to record last Telegram update snapshot', {
        avatarId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const userId = message.from?.id;

    // Skip messages sent by *this* bot (prevents self-triggered loops).
    // Do not skip other bots — multi-avatar channels rely on bot-to-bot interaction.
    const thisBotId = avatar.platforms.telegram?.botId;
    const thisBotUsername = avatar.platforms.telegram?.botUsername;
    if (message.from?.is_bot) {
      const fromId = message.from.id;
      const fromUsername = message.from.username;
      const isSelf =
        (typeof thisBotId === 'number' && fromId === thisBotId) ||
        (Boolean(thisBotUsername) && fromUsername === thisBotUsername);
      if (isSelf) return ok();
    }

    // Deduplication: Check if we already processed this update (prevents infinite loops on Lambda timeout/retry)
    const shouldProcess = await startMessageProcessing(avatarId, update.update_id);
    if (!shouldProcess) {
      logger.info('Skipping already processed update', { updateId: update.update_id });
      return ok();
    }

    try {
      const chatId = message.chat.id;
      const text = message.text || message.caption || '';
      const botUsername = avatar.platforms.telegram?.botUsername;

      // === MULTI-AGENT ROUTING ===
      // 1. If this bot is @mentioned directly OR replied to -> respond immediately (bypass initiative)
      // 2. If channel has multiple avatars -> use initiative system
      // 3. Otherwise -> use existing single-avatar behavior

      // Check if THIS bot is mentioned directly
      const isDirectMention = isBotMentioned(text, botUsername);

      // Check if THIS bot is being replied to (P1 - treat reply-to-bot as direct targeting)
      const botId = avatar.platforms.telegram?.botId;
      const isReplyToThisBot = !!(
        (botId && message.reply_to_message?.from?.id === botId) ||
        (botUsername && message.reply_to_message?.from?.username === botUsername)
      );

      // Direct engagement: either mention or reply-to-bot (both bypass initiative)
      const isDirectEngagement = isDirectMention || isReplyToThisBot;

      if (isDirectEngagement) {
        // DIRECT ENGAGEMENT: This bot responds, but still respect cooldown
        // Check if we're in cooldown to prevent spam
        const existingState = await channelState.getChannelState(avatarId, chatId);

        if (existingState?.state === 'COOLDOWN') {
          const cooldownRemaining = channelState.CHANNEL_CONFIG.COOLDOWN_DURATION_MS -
            (Date.now() - existingState.stateChangedAt);

          if (cooldownRemaining > 0) {
            const engagementType = isDirectMention ? 'mention' : 'reply';
            logger.info('Direct engagement ignored - in cooldown', {
              engagementType,
              botUsername,
              cooldownRemaining: Math.round(cooldownRemaining / 1000),
            });
            await markMessageProcessed(avatarId, update.update_id);
            return ok();
          }
        }

        const engagementType = isDirectMention ? 'mention' : 'reply-to-bot';
        logger.info('Direct engagement detected, responding', { engagementType, botUsername });
        const result = await processChannelMessage(avatarId, avatar, message, token);

        await markMessageProcessed(avatarId, update.update_id);

        logger.info('Direct engagement processed', {
          event: 'direct_engagement_processed',
          chatId,
          fromUser: userId,
          chatType: message.chat.type,
          updateId: update.update_id,
          responded: result.responded,
          reason: result.reason,
          engagementType,
          isReplyToBot: isReplyToThisBot,
        });

        return ok();
      }

      // Check if this is a multi-avatar chat (for group and channel chats)
      // Channels now support multi-avatar coordination just like groups
      const isMultiAvatarEligible = message.chat.type === 'group' || 
                                   message.chat.type === 'supergroup' || 
                                   message.chat.type === 'channel';
      let channelAvatars: SharedChannelRecord[] = [];
      let avatarRecord: AvatarRecord | null = null;

      if (isMultiAvatarEligible) {
        // Get avatar record for createdAt timestamp (fetched once, reused below)
        avatarRecord = await getAvatarRecord(avatarId);
        if (avatarRecord) {
          // Register this avatar in the shared channel (updates presence)
          await sharedChannel.ensureAvatarInChannel(
            chatId,
            avatarId,
            botUsername || '',
            avatarRecord.createdAt
          );

          // Get all avatars in this channel
          channelAvatars = await sharedChannel.getChannelAgents(chatId);
        }
      }

      let result: { responded: boolean; reason: string };

      if (isMultiAvatarEligible && channelAvatars.length > 1) {
        // MULTI-AGENT MODE: Use D&D-style initiative
        logger.info('Multi-avatar chat detected, using initiative system', {
          chatType: message.chat.type,
          avatarCount: channelAvatars.length,
        });

        if (!avatarRecord) {
          logger.warn('Avatar record not found', { avatarId });
          return ok();
        }

        result = await handleMultiAvatarMessage(
          avatarId,
          avatar,
          avatarRecord,
          message,
          token,
          channelAvatars
        );
      } else {
        // SINGLE-AGENT MODE: Use existing Kyro-style channel processing
        result = await processChannelMessage(avatarId, avatar, message, token);
      }

      await markMessageProcessed(avatarId, update.update_id);

      logger.info('Channel processed', {
        event: 'channel_processed',
        chatId,
        fromUser: userId,
        chatType: message.chat.type,
        updateId: update.update_id,
        responded: result.responded,
        reason: result.reason,
        multiAvatar: channelAvatars.length > 1,
        avatarCount: channelAvatars.length,
        isChannelPost,
      });

      return ok();
    } catch (error) {
      await clearMessageProcessing(avatarId, update.update_id);
      throw error;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown';
    const errorStack = error instanceof Error ? error.stack : undefined;

    logger.error('Webhook error', error, { event: 'webhook_error' });

    // Record error in auto-issues system
    recordError({
      error: errorMessage,
      stack: errorStack,
      subsystem: 'telegram',
      category: 'webhook_error',
      avatarId,
      requestId,
    }).catch(() => {
      // Ignore recording failures
    });

    return ok();
  }
}
