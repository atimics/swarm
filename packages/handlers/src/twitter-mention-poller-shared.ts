/**
 * Shared Twitter Mention Poller Handler
 *
 * Multi-tenant scheduled poller that:
 * - lists avatars from the state table
 * - filters to those with twitter enabled + mention_replies feature
 * - polls mentions per avatar with budget-aware limits
 * - filters to processable mentions (direct engagements, replies to bot)
 * - enqueues MessageQueueItemSchema-shaped items to a shared FIFO message queue
 *
 * Credit-efficient design:
 * - Twitter API deduplicates reads, so polling frequency is free
 * - Only NEW unique tweets cost API credits
 * - Budget tracking ensures we stay within tier limits
 */
import type { ScheduledHandler, Context } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import {
  TwitterAdapter,
  createStateService,
  createSecretsService,
  createActivityService,
  logger,
  type SwarmEnvelope,
} from '@swarm/core';
import { createTwitterUsageService, type TwitterUsageService } from './services/twitter-usage.js';
import { maxTwitterId } from './utils/twitter-id.js';
import { loadAvatarSecrets, type LoadedAvatarSecrets } from './utils/load-avatar-secrets.js';
import { isTwitterFeatureEnabled } from './utils/twitter-feature-flags.js';

const sqsClient = new SQSClient({});

const STATE_TABLE = process.env.STATE_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const MESSAGE_QUEUE_URL = process.env.MESSAGE_QUEUE_URL!;
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'swarm';

let stateService: ReturnType<typeof createStateService>;
let activityService: ReturnType<typeof createActivityService>;
let secretsService: ReturnType<typeof createSecretsService>;
let twitterUsageService: TwitterUsageService;

type TwitterAppCredentialsFallback = {
  TWITTER_APP_KEY?: string;
  TWITTER_APP_SECRET?: string;
  consumer_key?: string;
  consumer_secret?: string;
  consumerKey?: string;
  consumerSecret?: string;
};

async function loadTwitterSecretsFallback(
  secretsService: ReturnType<typeof createSecretsService>,
  avatarId: string,
  secretPrefix: string
): Promise<LoadedAvatarSecrets> {
  const result: LoadedAvatarSecrets = {};
  const candidates = (name: string) => [
    `${secretPrefix}/${avatarId}/${name}/default`,
    `${secretPrefix}/${avatarId}/${name}`,
  ];

  for (const id of candidates('twitter_access_token')) {
    try {
      result.TWITTER_ACCESS_TOKEN = await secretsService.getSecret(id);
      break;
    } catch {
      // Try next.
    }
  }

  for (const id of candidates('twitter_access_secret')) {
    try {
      result.TWITTER_ACCESS_SECRET = await secretsService.getSecret(id);
      break;
    } catch {
      // Try next.
    }
  }

  if (!result.TWITTER_API_KEY || !result.TWITTER_API_SECRET) {
    const appCandidates = [
      `${secretPrefix}/global/twitter-app-credentials`,
      `${secretPrefix}/global/twitter-app-credentials/default`,
    ];

    for (const id of appCandidates) {
      try {
        const parsed = await secretsService.getSecretJson<TwitterAppCredentialsFallback>(id);
        const appKey = parsed.TWITTER_APP_KEY || parsed.consumer_key || parsed.consumerKey;
        const appSecret = parsed.TWITTER_APP_SECRET || parsed.consumer_secret || parsed.consumerSecret;
        if (appKey) result.TWITTER_API_KEY = result.TWITTER_API_KEY || appKey;
        if (appSecret) result.TWITTER_API_SECRET = result.TWITTER_API_SECRET || appSecret;
        if (result.TWITTER_API_KEY && result.TWITTER_API_SECRET) break;
      } catch {
        // Try next.
      }
    }
  }

  return result;
}

async function initialize(): Promise<void> {
  if (stateService) return;
  stateService = createStateService(STATE_TABLE);
  activityService = createActivityService(ACTIVITY_TABLE);
  secretsService = createSecretsService();
  twitterUsageService = createTwitterUsageService(STATE_TABLE);
}

/**
 * Determine if a mention should be processed and replied to.
 *
 * Only reply to:
 * 1. Direct replies to bot's tweets (highest priority)
 * 2. Explicit @mentions in tweet text (not just part of a thread)
 */
function shouldProcessMention(
  mention: SwarmEnvelope,
  botUserId: string,
  botUsername?: string
): boolean {
  // Skip self-mentions (bot replying to itself)
  if (mention.sender.id === botUserId) {
    return false;
  }

  // Case 1: Reply to bot's own tweet (highest priority)
  // The raw tweet object contains in_reply_to_user_id
  const raw = mention.raw as { in_reply_to_user_id?: string };
  if (raw.in_reply_to_user_id === botUserId) {
    return true;
  }

  // Case 2: Direct @mention in tweet text
  // Check if bot is explicitly mentioned in the tweet text
  if (botUsername) {
    const text = mention.content.text?.toLowerCase() || '';
    const hasMentionInText = text.includes(`@${botUsername.toLowerCase()}`);
    if (hasMentionInText) {
      return true;
    }
  }

  // If we got here via the mentions timeline but don't match the above,
  // it's likely a retweet or quote that doesn't warrant a reply
  return false;
}

export const handler: ScheduledHandler = async (_event, context: Context) => {
  const startTime = Date.now();
  logger.setContext({
    platform: 'twitter',
    requestId: context.awsRequestId,
    handler: 'shared-mention-poller',
  });

  await initialize();

  // Check global budget before proceeding
  const budget = await twitterUsageService.getRemainingBudget();
  if (budget.daily <= 0) {
    logger.info('Twitter daily budget exhausted, skipping poll', {
      event: 'budget_exhausted',
      subsystem: 'twitter',
      usedToday: budget.usedToday,
      usedThisMonth: budget.usedThisMonth,
    });
    return;
  }

  const avatarIds = await stateService.listAvatars();

  // Get Twitter-enabled avatars for budget calculation
  const twitterAvatarIds: string[] = [];
  let twitterEnabledCount = 0;
  let twitterMissingFeaturesCount = 0;
  for (const avatarId of avatarIds) {
    const avatarConfig = await stateService.getAvatarConfig(avatarId);
    const twitterConfig = avatarConfig?.platforms?.twitter as { enabled?: boolean; features?: unknown } | undefined;
    const twitterEnabled = Boolean(twitterConfig?.enabled);
    if (twitterEnabled) twitterEnabledCount++;

    const mentionRepliesEnabled = isTwitterFeatureEnabled(twitterConfig?.features, 'mention_replies');
    if (twitterEnabled && !Array.isArray(twitterConfig?.features)) {
      twitterMissingFeaturesCount++;
    }

    if (twitterEnabled && mentionRepliesEnabled) {
      twitterAvatarIds.push(avatarId);
    }
  }

  if (twitterAvatarIds.length === 0) {
    logger.info('No Twitter-enabled avatars found', {
      event: 'handler_skipped',
      subsystem: 'twitter',
      reason: 'no_enabled_avatars',
      avatarCount: avatarIds.length,
      twitterEnabledCount,
      twitterMissingFeaturesCount,
    });
    return;
  }

  // Calculate budget-aware polling parameters
  const pollConfig = twitterUsageService.getPollConfig(twitterAvatarIds.length);
  const perAvatarLimit = Math.max(5, Math.min(pollConfig.maxMentionsPerPoll, 20));

  logger.info('Shared Twitter mention poller started', {
    event: 'handler_started',
    subsystem: 'twitter',
    avatarCount: twitterAvatarIds.length,
    budgetRemaining: budget.daily,
    perAvatarLimit,
    tier: pollConfig.tier,
  });

  let totalQueued = 0;
  let totalPolled = 0;
  let totalMentionsRead = 0;

  for (const avatarId of twitterAvatarIds) {
    try {
      // Re-check budget to avoid overspending if previous avatars used a lot
      const currentBudget = await twitterUsageService.getRemainingBudget();
      if (currentBudget.daily <= 0) {
        logger.info('Daily budget exhausted mid-poll, stopping', {
          event: 'budget_exhausted_mid_poll',
          subsystem: 'twitter',
          avatarId,
        });
        break;
      }

      const avatarConfig = await stateService.getAvatarConfig(avatarId);
      logger.setContext({ avatarId });

      let secrets: LoadedAvatarSecrets | undefined;
      try {
        secrets = await loadAvatarSecrets(secretsService, avatarId, SECRET_PREFIX);
      } catch (error) {
        logger.error('Failed to load avatar secrets; skipping avatar', error, {
          event: 'handler_skipped',
          subsystem: 'twitter',
          avatarId,
          reason: 'secrets_load_failed',
          secretPrefix: SECRET_PREFIX,
        });
        secrets = undefined;
      }

      if (!secrets || !secrets.TWITTER_ACCESS_TOKEN || !secrets.TWITTER_ACCESS_SECRET) {
        const fallback = await loadTwitterSecretsFallback(secretsService, avatarId, SECRET_PREFIX);
        secrets = {
          ...fallback,
          ...secrets,
        };
      }

      if (!secrets?.TWITTER_ACCESS_TOKEN || !secrets?.TWITTER_ACCESS_SECRET) {
        logger.warn('Twitter access token/secret missing for avatar; skipping', {
          event: 'handler_skipped',
          subsystem: 'twitter',
          avatarId,
          reason: 'missing_twitter_access_secrets',
          secretPrefix: SECRET_PREFIX,
        });
        continue;
      }

      const twitterAdapter = new TwitterAdapter(avatarConfig!, {
        appKey: secrets.TWITTER_API_KEY,
        appSecret: secrets.TWITTER_API_SECRET,
        accessToken: secrets.TWITTER_ACCESS_TOKEN,
        accessSecret: secrets.TWITTER_ACCESS_SECRET,
      });

      if (!twitterAdapter.isConfigured()) {
        logger.warn('Twitter adapter not configured for avatar; skipping', {
          event: 'handler_skipped',
          subsystem: 'twitter',
          reason: 'not_configured',
        });
        continue;
      }

      totalPolled++;
      const sinceId = await stateService.getLastMentionId(avatarId);

      logger.info('Cursor state before poll', {
        event: 'cursor_state',
        subsystem: 'twitter',
        avatarId,
        cursorBefore: sinceId,
      });

      // Fetch with budget-aware limit
      const effectiveLimit = Math.min(perAvatarLimit, currentBudget.daily);
      const mentions = await twitterAdapter.getMentions(sinceId ?? undefined, {
        maxResults: effectiveLimit,
      });

      // Record the API usage (these are the tweets we actually read)
      if (mentions.length > 0) {
        await twitterUsageService.recordMentionsRead(mentions.length);
        totalMentionsRead += mentions.length;
      }

      if (mentions.length === 0) continue;

      // Get bot info for filtering
      const botUserId = await twitterAdapter.getBotUserId();
      const botUsername = twitterAdapter.getBotUsername();

      // Sort oldest first for processing order
      const sortedMentions = mentions.sort((a, b) => a.timestamp - b.timestamp);
      let newestMentionId = sinceId;
      let avatarQueued = 0;
      let avatarFiltered = 0;

      for (const envelope of sortedMentions) {
        const traceId = randomUUID();
        envelope.traceId = traceId;

        // Log mention processing context
        const raw = envelope.raw as { in_reply_to_user_id?: string };
        const isReplyToBot = raw.in_reply_to_user_id === botUserId;
        const hasMentionInText = botUsername
          ? (envelope.content.text?.toLowerCase().includes(`@${botUsername.toLowerCase()}`) ?? false)
          : false;

        // Ensure the message-processor's channel state sees this as direct engagement.
        // (The response trigger logic is driven by `envelope.metadata.isMention/isReplyToBot`.)
        envelope.metadata.isReplyToBot = isReplyToBot;
        envelope.metadata.isMention = hasMentionInText;

        logger.debug('Processing mention', {
          event: 'mention_processing',
          subsystem: 'twitter',
          avatarId,
          tweetId: envelope.messageId,
          threadId: envelope.conversationId,
          senderId: envelope.sender.id,
          senderUsername: envelope.sender.username,
          isReplyToBot,
          hasMentionInText,
        });

        // Filter to only processable mentions using the new logic
        if (!shouldProcessMention(envelope, botUserId, botUsername)) {
          logger.debug('Skipping non-processable mention', {
            event: 'mention_filtered',
            subsystem: 'twitter',
            avatarId,
            tweetId: envelope.messageId,
            senderId: envelope.sender.id,
            senderUsername: envelope.sender.username,
            isReplyToBot,
            hasMentionInText,
          });
          avatarFiltered++;
          // Still update the cursor even for filtered mentions (using numeric comparison)
          newestMentionId = maxTwitterId(newestMentionId, envelope.messageId);
          continue;
        }

        // Ingest idempotency - check if we've already processed this tweet
        const idempotencyKey = `twitter:${avatarId}:${envelope.messageId}`;
        const isNewMention = await stateService.checkAndSetIdempotency(idempotencyKey, 24 * 60 * 60);
        if (!isNewMention) {
          logger.info('Duplicate mention detected at ingest, skipping', {
            event: 'ingest_dedupe_hit',
            subsystem: 'twitter',
            avatarId,
            tweetId: envelope.messageId,
            idempotencyKey,
          });
          // Still update cursor to prevent re-polling
          newestMentionId = maxTwitterId(newestMentionId, envelope.messageId);
          continue;
        }

        await activityService.logMessageReceived(
          avatarId,
          'twitter',
          envelope.sender.displayName || envelope.sender.username || 'Unknown',
          envelope.content.text || ''
        );

        const deduplicationId = `twitter-mention-${avatarId}-${envelope.messageId}`;
        const messageGroupId = `${avatarId}#${envelope.conversationId}`;

        await sqsClient.send(new SendMessageCommand({
          QueueUrl: MESSAGE_QUEUE_URL,
          MessageBody: JSON.stringify({
            envelope,
            enqueuedAt: Date.now(),
            attempts: 0,
            maxAttempts: 3,
          }),
          MessageAttributes: {
            traceId: {
              DataType: 'String',
              StringValue: traceId,
            },
          },
          MessageGroupId: messageGroupId,
          MessageDeduplicationId: deduplicationId,
        }));

        logger.debug('Message enqueued', {
          event: 'mention_enqueued',
          subsystem: 'twitter',
          avatarId,
          tweetId: envelope.messageId,
          threadId: envelope.conversationId,
          deduplicationId,
          messageGroupId,
        });

        totalQueued++;
        avatarQueued++;

        // Update cursor using numeric comparison for Twitter snowflake IDs
        newestMentionId = maxTwitterId(newestMentionId, envelope.messageId);
      }

      if (newestMentionId && newestMentionId !== sinceId) {
        await stateService.setLastMentionId(avatarId, newestMentionId);
      }

      logger.info('Cursor state after poll', {
        event: 'cursor_updated',
        subsystem: 'twitter',
        avatarId,
        cursorBefore: sinceId,
        cursorAfter: newestMentionId,
        cursorAdvanced: newestMentionId !== sinceId,
        mentionsRead: sortedMentions.length,
        mentionsQueued: avatarQueued,
        mentionsFiltered: avatarFiltered,
      });
    } catch (error) {
      logger.error('Failed to poll Twitter mentions for avatar', error, {
        event: 'handler_error',
        subsystem: 'twitter',
        avatarId,
      });
    }
  }

  logger.info('Shared Twitter mention poller complete', {
    event: 'poll_complete',
    subsystem: 'twitter',
    polledAvatars: totalPolled,
    mentionsRead: totalMentionsRead,
    queued: totalQueued,
    durationMs: Date.now() - startTime,
  });
};
