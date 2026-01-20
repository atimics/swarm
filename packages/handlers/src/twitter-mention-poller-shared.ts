/**
 * Shared Twitter Mention Poller Handler
 *
 * Multi-tenant scheduled poller that:
 * - lists avatars from the state table
 * - filters to those with twitter enabled + mention_replies feature
 * - polls mentions per avatar
 * - enqueues MessageQueueItemSchema-shaped items to a shared FIFO message queue
 */
import type { ScheduledHandler, Context } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  TwitterAdapter,
  createStateService,
  createSecretsService,
  createActivityService,
  logger,
} from '@swarm/core';

const sqsClient = new SQSClient({});

const STATE_TABLE = process.env.STATE_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const MESSAGE_QUEUE_URL = process.env.MESSAGE_QUEUE_URL!;
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'swarm';

let stateService: ReturnType<typeof createStateService>;
let activityService: ReturnType<typeof createActivityService>;
let secretsService: ReturnType<typeof createSecretsService>;

async function initialize(): Promise<void> {
  if (stateService) return;
  stateService = createStateService(STATE_TABLE);
  activityService = createActivityService(ACTIVITY_TABLE);
  secretsService = createSecretsService();
}

export const handler: ScheduledHandler = async (_event, context: Context) => {
  const startTime = Date.now();
  logger.setContext({
    platform: 'twitter',
    requestId: context.awsRequestId,
    handler: 'shared-mention-poller',
  });

  await initialize();

  const avatarIds = await stateService.listAvatars();
  logger.info('Shared Twitter mention poller started', {
    event: 'handler_started',
    subsystem: 'twitter',
    avatarCount: avatarIds.length,
  });

  let totalQueued = 0;
  let totalPolled = 0;

  for (const avatarId of avatarIds) {
    try {
      const avatarConfig = await stateService.getAvatarConfig(avatarId);
      const twitterEnabled = Boolean(avatarConfig?.platforms?.twitter?.enabled);
      const twitterFeatures = avatarConfig?.platforms?.twitter?.features || [];
      const mentionRepliesEnabled = twitterFeatures.includes('mention_replies');

      if (!twitterEnabled || !mentionRepliesEnabled) {
        continue;
      }

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
      const mentions = await twitterAdapter.getMentions(sinceId ?? undefined);
      if (mentions.length === 0) continue;

      const sortedMentions = mentions.sort((a, b) => a.timestamp - b.timestamp);
      let newestMentionId = sinceId;

      for (const envelope of sortedMentions) {
        // Skip self-mentions (our own tweets)
        if (envelope.sender.username === avatarConfig?.platforms?.twitter?.username) {
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
    queued: totalQueued,
    durationMs: Date.now() - startTime,
  });
};
