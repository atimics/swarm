/**
 * Response Sender Handler
 * Sends generated responses to platforms
 */
import type { SQSEvent, Context, SQSBatchResponse, Handler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { randomUUID } from 'crypto';
import {
  TelegramAdapter,
  TwitterAdapter,
  WebAdapter,
  DiscordAdapter,
  PlatformRegistry,
  createStateService,
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
const secretsClient = new SecretsManagerClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

// Environment variables
const MEDIA_QUEUE_URL = process.env.MEDIA_QUEUE_URL;
const STATE_TABLE = process.env.STATE_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const LEGACY_AVATAR_ID = process.env.AVATAR_ID;
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'swarm';
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

// Services
let stateService: ReturnType<typeof createStateService>;
let activityService: ReturnType<typeof createActivityService>;

type AvatarOutboundRuntime = {
  avatarId: string;
  avatarConfig: AvatarConfig;
  secrets: Record<string, string>;
  platformRegistry: PlatformRegistry;
  outboundSender: ReturnType<typeof createOutboundSender>;
};

const outboundCache = new Map<string, AvatarOutboundRuntime>();

function getResponseKey(response: SwarmResponse, recordMessageId: string): string {
  const anchor = response.replyToMessageId ?? response.generatedAt ?? recordMessageId;
  return `${response.conversationId}#${anchor}`;
}

async function wasResponseHandled(avatarId: string, responseKey: string): Promise<boolean> {
  const result = await dynamo.send(new GetCommand({
    TableName: STATE_TABLE,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: `RESPONSE#${responseKey}`,
    },
  }));
  return Boolean(result.Item);
}

async function markResponseHandled(avatarId: string, responseKey: string): Promise<void> {
  const now = Date.now();
  const ttl = Math.floor(now / 1000) + IDEMPOTENCY_TTL_SECONDS;
  try {
    await dynamo.send(new PutCommand({
      TableName: STATE_TABLE,
      Item: {
        pk: `AVATAR#${avatarId}`,
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
      avatarId,
      responseKey,
    });
  }
}

async function initialize(): Promise<void> {
  if (stateService) return;

  stateService = createStateService(STATE_TABLE);
  activityService = createActivityService(ACTIVITY_TABLE);
}

/**
 * Fetch individual secrets from Secrets Manager using direct paths
 * Falls back to global secrets if avatar-specific secrets are not found
 */
async function fetchAvatarSecrets(avatarId: string): Promise<Record<string, string>> {
  const secrets: Record<string, string> = {};

  // Shared Twitter app credentials are stored as a single JSON secret.
  // This keeps app credentials centralized while per-avatar OAuth tokens remain per-secret.
  // Do not fail hard if it is missing; some avatars may not use Twitter.
  async function tryLoadTwitterAppCredentials(): Promise<void> {
    if (secrets.TWITTER_API_KEY && secrets.TWITTER_API_SECRET) return;
    const secretId = process.env.TWITTER_APP_CREDENTIALS_ARN || `${SECRET_PREFIX}/global/twitter-app-credentials`;
    try {
      const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }));
      const raw = response.SecretString;
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const appKey = (parsed.TWITTER_APP_KEY || parsed.consumer_key || parsed.consumerKey) as string | undefined;
      const appSecret = (parsed.TWITTER_APP_SECRET || parsed.consumer_secret || parsed.consumerSecret) as string | undefined;
      if (appKey && !secrets.TWITTER_API_KEY) secrets.TWITTER_API_KEY = appKey;
      if (appSecret && !secrets.TWITTER_API_SECRET) secrets.TWITTER_API_SECRET = appSecret;
    } catch {
      // Ignore parse/lookup errors and rely on per-avatar secrets if present.
    }
  }

  // Define secret types to fetch and their normalized key names
  const secretTypes = [
    { type: 'telegram_bot_token', key: 'TELEGRAM_BOT_TOKEN' },
    { type: 'twitter_api_key', key: 'TWITTER_API_KEY' },
    { type: 'twitter_api_secret', key: 'TWITTER_API_SECRET' },
    { type: 'twitter_access_token', key: 'TWITTER_ACCESS_TOKEN' },
    { type: 'twitter_access_secret', key: 'TWITTER_ACCESS_SECRET' },
    { type: 'discord_bot_token', key: 'DISCORD_BOT_TOKEN' },
  ];

  for (const { type, key } of secretTypes) {
    // Try avatar-specific secret first
    let secretName = `${SECRET_PREFIX}/${avatarId}/${type}/default`;
    try {
      const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
      if (response.SecretString) {
        secrets[key] = response.SecretString;
        continue;
      }
    } catch {
      // Avatar secret not found, try global
    }

    // Fall back to global secret
    secretName = `${SECRET_PREFIX}/global/${type}/default`;
    try {
      const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
      if (response.SecretString) {
        secrets[key] = response.SecretString;
        continue;
      }
    } catch {
      // Global secret not found either - continue without it
    }

    if (type === 'twitter_api_key' || type === 'twitter_api_secret') {
      await tryLoadTwitterAppCredentials();
    }
  }

  return secrets;
}

async function getOutboundRuntime(avatarId: string): Promise<AvatarOutboundRuntime> {
  const cached = outboundCache.get(avatarId);
  if (cached) return cached;

  const avatarConfig = await stateService.getAvatarConfig(avatarId) || {
    id: avatarId,
    name: avatarId,
    version: '1.0.0',
    persona: '',
    platforms: {},
    llm: { provider: DEFAULT_LLM_PROVIDER, model: DEFAULT_LLM_MODEL, temperature: DEFAULT_LLM_TEMPERATURE, maxTokens: DEFAULT_LLM_MAX_TOKENS },
    media: { image: { provider: 'replicate', model: 'black-forest-labs/flux-schnell' } },
    scheduling: {},
    behavior: { responseDelayMs: [1000, 3000], typingIndicator: true, ignoreBots: true, cooldownMinutes: 5, maxContextMessages: 20 },
    tools: [],
    secrets: [],
  };

  // Fetch individual secrets from Secrets Manager using direct paths
  const secrets = await fetchAvatarSecrets(avatarId);

  const platformRegistry = new PlatformRegistry();

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

  const outboundSender = createOutboundSender(platformRegistry, activityService);

  const runtime: AvatarOutboundRuntime = {
    avatarId,
    avatarConfig,
    secrets,
    platformRegistry,
    outboundSender,
  };

  outboundCache.set(avatarId, runtime);
  return runtime;
}

export const handler: Handler<SQSEvent, SQSBatchResponse> = async (
  event: SQSEvent,
  context: Context
) => {
  logger.setContext({
    avatarId: LEGACY_AVATAR_ID || 'shared',
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
      const traceId = record.messageAttributes?.traceId?.stringValue;

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
      const avatarId = response.avatarId || LEGACY_AVATAR_ID;
      if (!avatarId) {
        logger.error('Missing avatarId in response (shared sender requires response.avatarId)', {
          event: 'validation_error',
          subsystem: 'outbound',
          messageId: record.messageId,
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      if (await wasResponseHandled(avatarId, responseKey)) {
        logger.info('Skipping already handled response', {
          event: 'response_skipped',
          subsystem: 'outbound',
          reason: 'already_handled',
          responseKey,
        });
        continue;
      }

      const outboundRuntime = await getOutboundRuntime(avatarId);

      logger.setContext({
        avatarId,
        platform: response.platform,
        conversationId: response.conversationId,
        traceId,
      });

      logger.info('Sending response', {
        event: 'sending_response',
        subsystem: 'outbound',
        actions: response.actions.length,
      });

      // Log Twitter-specific reply targeting for observability
      if (response.platform === 'twitter') {
        logger.info('Twitter reply targeting', {
          event: 'twitter_reply_target',
          subsystem: 'outbound',
          avatarId,
          threadId: response.conversationId,
          replyToMessageId: response.replyToMessageId,
        });
      }

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
                avatarId,
                conversationId: response.conversationId,
                action,
                response,
                traceId,
              }),
              MessageAttributes: traceId
                ? { traceId: { DataType: 'String', StringValue: traceId } }
                : undefined,
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
        const result = await outboundRuntime.outboundSender.send({ ...response, actions: actionsToSend });
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
            avatarId,
            response.conversationId,
            response.platform,
            {
              messageId: `bot_${randomUUID()}`,
              sender: outboundRuntime.avatarConfig.name,
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
            avatarId,
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
        await markResponseHandled(avatarId, responseKey);
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
