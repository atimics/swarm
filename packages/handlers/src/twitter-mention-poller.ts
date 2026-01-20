/**
 * Twitter Mention Poller Handler
 * Polls Twitter for mentions and sends them to the message queue for processing
 */
import type { ScheduledHandler, Context } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  TwitterAdapter,
  createStateService,
  createSecretsService,
  createActivityService,
  logger,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_LLM_TEMPERATURE,
  DEFAULT_LLM_MAX_TOKENS,
  type AvatarConfig,
} from '@swarm/core';

// Environment variables
const STATE_TABLE = process.env.STATE_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const AVATAR_ID = process.env.AVATAR_ID!;
const MESSAGE_QUEUE_URL = process.env.MESSAGE_QUEUE_URL!;

// Services
let stateService: ReturnType<typeof createStateService>;
let activityService: ReturnType<typeof createActivityService>;
let secretsService: ReturnType<typeof createSecretsService>;
let sqsClient: SQSClient;
let twitterAdapter: TwitterAdapter;
let secrets: Record<string, string>;
let avatarConfig: AvatarConfig;

async function initialize(): Promise<void> {
  if (stateService) return;

  stateService = createStateService(STATE_TABLE);
  activityService = createActivityService(ACTIVITY_TABLE);
  secretsService = createSecretsService();
  sqsClient = new SQSClient({});

  avatarConfig = await stateService.getAvatarConfig(AVATAR_ID) || {
    id: AVATAR_ID,
    name: AVATAR_ID,
    version: '1.0.0',
    persona: '',
    platforms: {
      twitter: { enabled: true, username: '', features: ['mention_replies'] },
    },
    llm: { provider: DEFAULT_LLM_PROVIDER, model: DEFAULT_LLM_MODEL, temperature: DEFAULT_LLM_TEMPERATURE, maxTokens: DEFAULT_LLM_MAX_TOKENS },
    media: { image: { provider: 'replicate', model: 'black-forest-labs/flux-schnell' } },
    scheduling: {},
    behavior: { responseDelayMs: [1000, 3000], typingIndicator: false, ignoreBots: true, cooldownMinutes: 5, maxContextMessages: 10 },
    tools: ['send_message', 'react', 'ignore'],
    secrets: [],
  };

  secrets = await secretsService.getSecretJson<Record<string, string>>(
    process.env.SECRETS_ARN || `swarm/${AVATAR_ID}/secrets`
  );

  twitterAdapter = new TwitterAdapter(avatarConfig, {
    appKey: secrets.TWITTER_API_KEY,
    appSecret: secrets.TWITTER_API_SECRET,
    accessToken: secrets.TWITTER_ACCESS_TOKEN,
    accessSecret: secrets.TWITTER_ACCESS_SECRET,
  });
}

export const handler: ScheduledHandler = async (_event, context: Context) => {
  const startTime = Date.now();
  logger.setContext({
    avatarId: AVATAR_ID,
    platform: 'twitter',
    requestId: context.awsRequestId,
    handler: 'mention-poller',
  });

  logger.info('Twitter mention poller started', {
    event: 'handler_started',
    subsystem: 'twitter',
  });

  try {
    await initialize();

    if (!twitterAdapter.isConfigured()) {
      logger.warn('Twitter adapter not configured, skipping mention poll', {
        event: 'handler_skipped',
        subsystem: 'twitter',
        reason: 'not_configured',
      });
      return;
    }

    logger.info('Polling for Twitter mentions', {
      event: 'poll_started',
      subsystem: 'twitter',
    });

    // Get the last processed mention ID from state
    const sinceId = await stateService.getLastMentionId(AVATAR_ID);

    logger.info('Fetching mentions', {
      event: 'api_request',
      subsystem: 'twitter',
      sinceId,
    });

    // Get new mentions
    const mentions = await twitterAdapter.getMentions(sinceId ?? undefined);

    if (mentions.length === 0) {
      logger.info('No new mentions found', {
        event: 'poll_complete',
        subsystem: 'twitter',
        count: 0,
      });
      return;
    }

    logger.info('Found new mentions', {
      event: 'mentions_found',
      subsystem: 'twitter',
      count: mentions.length,
    });

    // Process mentions (oldest first)
    const sortedMentions = mentions.sort((a, b) => a.timestamp - b.timestamp);
    let newestMentionId = sinceId;

    for (const envelope of sortedMentions) {
      // Skip self-mentions (our own tweets)
      if (envelope.sender.username === avatarConfig.platforms.twitter?.username) {
        logger.debug('Skipping self-mention', {
          event: 'mention_skipped',
          subsystem: 'twitter',
          reason: 'self_mention',
          messageId: envelope.messageId,
        });
        continue;
      }

      // Log the mention
      await activityService.logMessageReceived(
        AVATAR_ID,
        'twitter',
        envelope.sender.displayName || envelope.sender.username || 'Unknown',
        envelope.content.text || ''
      );

      // Send to message queue for processing
      await sqsClient.send(new SendMessageCommand({
        QueueUrl: MESSAGE_QUEUE_URL,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: envelope.conversationId,
        MessageDeduplicationId: `twitter-mention-${envelope.messageId}`,
      }));

      logger.info('Queued mention for processing', {
        event: 'mention_queued',
        subsystem: 'twitter',
        messageId: envelope.messageId,
        from: envelope.sender.username,
      });

      // Track the newest mention ID
      if (!newestMentionId || envelope.messageId > newestMentionId) {
        newestMentionId = envelope.messageId;
      }
    }

    // Update the last processed mention ID
    if (newestMentionId && newestMentionId !== sinceId) {
      await stateService.setLastMentionId(AVATAR_ID, newestMentionId);
      logger.info('Updated last mention ID', {
        event: 'state_updated',
        subsystem: 'twitter',
        lastMentionId: newestMentionId,
      });
    }

    logger.info('Mention polling complete', {
      event: 'poll_complete',
      subsystem: 'twitter',
      processed: sortedMentions.length,
      lastMentionId: newestMentionId,
      durationMs: Date.now() - startTime,
    });

  } catch (error) {
    logger.error('Failed to poll Twitter mentions', error, {
      event: 'handler_error',
      subsystem: 'twitter',
      durationMs: Date.now() - startTime,
    });

    await activityService.logError(
      AVATAR_ID,
      'twitter',
      error instanceof Error ? error.message : String(error)
    );

    throw error;
  }
};
