/**
 * Response Sender Handler
 * Sends generated responses to platforms
 */
import type { SQSEvent, Context, SQSBatchResponse, Handler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'crypto';
import {
  TelegramAdapter,
  TwitterAdapter,
  WebAdapter,
  DiscordAdapter,
  PlatformRegistry,
  createStateService,
  createSecretsService,
  createActivityService,
  createOutboundSender,
  logger,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_LLM_TEMPERATURE,
  DEFAULT_LLM_MAX_TOKENS,
  type AvatarConfig,
  type SwarmResponse,
  type ResponseAction,
} from '@swarm/core';

const sqs = new SQSClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

// Environment variables
const MEDIA_QUEUE_URL = process.env.MEDIA_QUEUE_URL;
const STATE_TABLE = process.env.STATE_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const AVATAR_ID = process.env.AVATAR_ID!;
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

// Services
let stateService: ReturnType<typeof createStateService>;
let activityService: ReturnType<typeof createActivityService>;
let secretsService: ReturnType<typeof createSecretsService>;
let platformRegistry: PlatformRegistry;
let outboundSender: ReturnType<typeof createOutboundSender>;
let secrets: Record<string, string>;
let avatarConfig: AvatarConfig;

function getResponseKey(response: SwarmResponse, recordMessageId: string): string {
  const anchor = response.replyToMessageId ?? response.generatedAt ?? recordMessageId;
  return `${response.conversationId}#${anchor}`;
}

async function wasResponseHandled(responseKey: string): Promise<boolean> {
  const result = await dynamo.send(new GetCommand({
    TableName: STATE_TABLE,
    Key: {
      pk: `AVATAR#${AVATAR_ID}`,
      sk: `RESPONSE#${responseKey}`,
    },
  }));
  return Boolean(result.Item);
}

async function markResponseHandled(responseKey: string): Promise<void> {
  const now = Date.now();
  const ttl = Math.floor(now / 1000) + IDEMPOTENCY_TTL_SECONDS;
  try {
    await dynamo.send(new PutCommand({
      TableName: STATE_TABLE,
      Item: {
        pk: `AVATAR#${AVATAR_ID}`,
        sk: `RESPONSE#${responseKey}`,
        createdAt: now,
        ttl,
      },
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    }));
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return;
    }
    logger.warn('Failed to record response idempotency', {
      error: error instanceof Error ? error.message : String(error),
      responseKey,
    });
  }
}

async function initialize(): Promise<void> {
  if (stateService) return;

  stateService = createStateService(STATE_TABLE);
  activityService = createActivityService(ACTIVITY_TABLE);
  secretsService = createSecretsService();

  // Load config and secrets
  avatarConfig = await stateService.getAvatarConfig(AVATAR_ID) || {
    id: AVATAR_ID,
    name: AVATAR_ID,
    version: '1.0.0',
    persona: '',
    platforms: {},
    llm: { provider: DEFAULT_LLM_PROVIDER, model: DEFAULT_LLM_MODEL, temperature: DEFAULT_LLM_TEMPERATURE, maxTokens: DEFAULT_LLM_MAX_TOKENS },
    media: { image: { provider: 'replicate', model: 'f2ab8a5bfe79f02f0789a146cf5e73d2a4ff2684a98c2b303d1e1ff3814271db' } }, // flux-schnell
    scheduling: {},
    behavior: { responseDelayMs: [1000, 3000], typingIndicator: true, ignoreBots: true, cooldownMinutes: 5, maxContextMessages: 20 },
    tools: [],
    secrets: [],
  };

  secrets = await secretsService.getSecretJson<Record<string, string>>(
    process.env.SECRETS_ARN || `swarm/${AVATAR_ID}/secrets`
  );

  // Initialize platform adapters
  platformRegistry = new PlatformRegistry();

  if (avatarConfig.platforms.telegram?.enabled && secrets.TELEGRAM_BOT_TOKEN) {
    platformRegistry.register(new TelegramAdapter(avatarConfig, secrets.TELEGRAM_BOT_TOKEN));
  }

  if (avatarConfig.platforms.twitter?.enabled && secrets.TWITTER_API_KEY) {
    platformRegistry.register(new TwitterAdapter(avatarConfig, {
      appKey: secrets.TWITTER_API_KEY,
      appSecret: secrets.TWITTER_API_SECRET,
      accessToken: secrets.TWITTER_ACCESS_TOKEN,
      accessSecret: secrets.TWITTER_ACCESS_SECRET,
    }));
  }

  if (avatarConfig.platforms.web?.enabled) {
    platformRegistry.register(new WebAdapter(avatarConfig));
  }

  if (avatarConfig.platforms.discord?.enabled) {
    platformRegistry.register(new DiscordAdapter(avatarConfig, {
      botToken: secrets.DISCORD_BOT_TOKEN || secrets.discord_bot_token,
      webhookUrl: avatarConfig.platforms.discord.webhookUrl,
      webhookId: avatarConfig.platforms.discord.webhookId,
      webhookToken: avatarConfig.platforms.discord.webhookToken,
      applicationId: avatarConfig.platforms.discord.applicationId,
      publicKey: avatarConfig.platforms.discord.publicKey,
    }));
  }

  outboundSender = createOutboundSender(platformRegistry, activityService);
}

export const handler: Handler<SQSEvent, SQSBatchResponse> = async (
  event: SQSEvent,
  context: Context
) => {
  logger.setContext({
    avatarId: AVATAR_ID,
    requestId: context.awsRequestId,
  });

  logger.info('Response sender invoked', {
    event: 'handler_started',
    subsystem: 'outbound',
    recordCount: event.Records.length,
  });

  await initialize();
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

  for (const record of event.Records) {
    try {
      let response: SwarmResponse;
      try {
        response = JSON.parse(record.body);
      } catch (parseError) {
        logger.error('Failed to parse message body as JSON', parseError, {
          event: 'parse_error',
          subsystem: 'outbound',
          messageId: record.messageId,
          bodyPreview: record.body?.slice(0, 100),
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      const responseKey = getResponseKey(response, record.messageId);
      if (await wasResponseHandled(responseKey)) {
        logger.info('Skipping already handled response', {
          event: 'response_skipped',
          subsystem: 'outbound',
          reason: 'already_handled',
          responseKey,
        });
        continue;
      }

      logger.setContext({
        platform: response.platform,
        conversationId: response.conversationId,
      });

      logger.info('Sending response', {
        event: 'sending_response',
        subsystem: 'outbound',
        actions: response.actions.length,
      });

      // Check for media generation actions - queue them first
      const mediaActions = response.actions.filter(
        (a: ResponseAction) => a.type === 'take_selfie' || a.type === 'generate_video'
      );
      const nonMediaActions = response.actions.filter(
        (a: ResponseAction) => a.type !== 'take_selfie' && a.type !== 'generate_video'
      );
      let actionsToSend: ResponseAction[] | null = null;
      let queuedMedia = false;
      let sentMessages: string[] = [];
      let sendSuccess = false;

      if (mediaActions.length > 0) {
        if (MEDIA_QUEUE_URL) {
          // Queue media generation and wait
          for (const action of mediaActions) {
            const jobId = randomUUID();
            await sqs.send(new SendMessageCommand({
              QueueUrl: MEDIA_QUEUE_URL,
              MessageBody: JSON.stringify({
                jobId,
                avatarId: AVATAR_ID,
                conversationId: response.conversationId,
                action,
                response,
              }),
              MessageGroupId: response.conversationId,
              MessageDeduplicationId: `media_${jobId}`,
            }));
          }

          logger.info('Media generation queued', { count: mediaActions.length });
          queuedMedia = true;

          // For now, send text response without media
          // Media will be sent when generation completes via callback
          if (nonMediaActions.length > 0) {
            actionsToSend = nonMediaActions;
          }
        } else {
          logger.error('MEDIA_QUEUE_URL is not configured; skipping media generation');
          actionsToSend = nonMediaActions.length > 0
            ? nonMediaActions
            : [{
                type: 'send_message',
                text: 'Media generation is unavailable right now.',
              }];
        }
      } else {
        // No media actions, send directly
        actionsToSend = response.actions;
      }

      if (actionsToSend && actionsToSend.length > 0) {
        const result = await outboundSender.send({ ...response, actions: actionsToSend });
        sentMessages = result.sentMessages;
        sendSuccess = result.success;

        if (result.errors.length > 0) {
          logger.warn('Some actions failed', { errors: result.errors });
        }
      } else {
        sendSuccess = queuedMedia;
      }

      // Update channel state with bot's response
      for (const text of sentMessages) {
        try {
          await stateService.addMessageToChannel(
            AVATAR_ID,
            response.conversationId,
            response.platform,
            {
              messageId: `bot_${randomUUID()}`,
              sender: avatarConfig.name,
              isBot: true,
              content: text,
              timestamp: Date.now(),
            }
          );
        } catch (error) {
          logger.warn('Failed to update channel state for sent message', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const hasActionsToSend = Boolean(actionsToSend && actionsToSend.length > 0);
      const hasSendMessageAction = actionsToSend?.some(
        (a: ResponseAction) => a.type === 'send_message'
      ) ?? false;
      if (hasSendMessageAction && sentMessages.length === 0) {
        sendSuccess = false;
        logger.warn('send_message action failed to deliver', {
          event: 'send_failed',
          subsystem: 'outbound',
          conversationId: response.conversationId,
        });
      }
      const shouldMarkResponse = hasActionsToSend
        ? (hasSendMessageAction ? sentMessages.length > 0 : sendSuccess)
        : false;
      if (shouldMarkResponse) {
        try {
          await stateService.markResponseSent(
            AVATAR_ID,
            response.conversationId,
            `resp_${response.replyToMessageId || Date.now()}_${Date.now()}`
          );
        } catch (error) {
          logger.warn('Failed to mark response sent', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (sendSuccess) {
        await markResponseHandled(responseKey);
      }

      if (actionsToSend && actionsToSend.length > 0 && !sendSuccess) {
        batchItemFailures.push({ itemIdentifier: record.messageId });
        logger.error('Response actions failed to send', {
          event: 'send_error',
          subsystem: 'outbound',
          messageId: record.messageId,
          platform: response.platform,
        });
        continue;
      }

      logger.info('Response sent successfully', {
        event: 'response_sent',
        subsystem: 'outbound',
        conversationId: response.conversationId,
        platform: response.platform,
        actionCount: actionsToSend?.length || 0,
      });

    } catch (error) {
      logger.error('Failed to send response', error, {
        event: 'handler_error',
        subsystem: 'outbound',
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
