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

const sqsClient = new SQSClient({});

const STATE_TABLE = process.env.STATE_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const MESSAGE_QUEUE_URL = process.env.MESSAGE_QUEUE_URL!;
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'swarm';

let stateService: ReturnType<typeof createStateService>;
let activityService: ReturnType<typeof createActivityService>;
let secretsService: ReturnType<typeof createSecretsService>;
let twitterUsageService: TwitterUsageService;

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
  for (const avatarId of avatarIds) {
    const avatarConfig = await stateService.getAvatarConfig(avatarId);
    const twitterEnabled = Boolean(avatarConfig?.platforms?.twitter?.enabled);
    const twitterFeatures = avatarConfig?.platforms?.twitter?.features || [];
    const mentionRepliesEnabled = twitterFeatures.includes('mention_replies');
    if (twitterEnabled && mentionRepliesEnabled) {
      twitterAvatarIds.push(avatarId);
    }
  }

  if (twitterAvatarIds.length === 0) {
    logger.info('No Twitter-enabled avatars found', {
      event: 'handler_skipped',
      subsystem: 'twitter',
      reason: 'no_enabled_avatars',
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

      const secrets = await secretsService.getSecretJson<Record<string, string>>(
        `${SECRET_PREFIX}/${avatarId}/secrets`
      );

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

      for (const envelope of sortedMentions) {
        const traceId = randomUUID();
        envelope.traceId = traceId;

        // Filter to only processable mentions using the new logic
        if (!shouldProcessMention(envelope, botUserId, botUsername)) {
          logger.debug('Skipping non-processable mention', {
            event: 'mention_filtered',
            subsystem: 'twitter',
            senderId: envelope.sender.id,
            senderUsername: envelope.sender.username,
          });
          // Still update the cursor even for filtered mentions
          if (!newestMentionId || envelope.messageId > newestMentionId) {
            newestMentionId = envelope.messageId;
          }
          continue;
        }

        await activityService.logMessageReceived(
          avatarId,
          'twitter',
          envelope.sender.displayName || envelope.sender.username || 'Unknown',
          envelope.content.text || ''
        );

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
          MessageGroupId: `${avatarId}#${envelope.conversationId}`,
          MessageDeduplicationId: `twitter-mention-${avatarId}-${envelope.messageId}`,
        }));

        totalQueued++;

        if (!newestMentionId || envelope.messageId > newestMentionId) {
          newestMentionId = envelope.messageId;
        }
      }

      if (newestMentionId && newestMentionId !== sinceId) {
        await stateService.setLastMentionId(avatarId, newestMentionId);
      }
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
