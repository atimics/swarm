/**
 * Telegram Webhook Handler
 * Handles incoming Telegram bot webhooks
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  TelegramAdapter,
  createStateService,
  createSecretsService,
  createActivityService,
  createMessageEvaluator,
  logger,
  DEFAULT_LLM_MODEL,
  type AvatarConfig,
} from '@swarm/core';
import { randomUUID, timingSafeEqual } from 'crypto';

const sqs = new SQSClient({});
const secretsClient = new SecretsManagerClient({});

// Environment variables
const MESSAGE_QUEUE_URL = process.env.MESSAGE_QUEUE_URL!;
const STATE_TABLE = process.env.STATE_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const AVATAR_ID = process.env.AVATAR_ID!;
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'swarm';

// Lazy-initialized services
let stateService: ReturnType<typeof createStateService>;
let activityService: ReturnType<typeof createActivityService>;
let secretsService: ReturnType<typeof createSecretsService>;
let telegramAdapter: TelegramAdapter;
let avatarConfig: AvatarConfig;

// Webhook secret cache
let cachedWebhookSecret: { value: string; expiresAt: number } | null = null;
const WEBHOOK_SECRET_TTL = 5 * 60 * 1000;

async function getWebhookSecret(): Promise<string | null> {
  const now = Date.now();
  if (cachedWebhookSecret && cachedWebhookSecret.expiresAt > now) {
    return cachedWebhookSecret.value;
  }

  const secretName = `${SECRET_PREFIX}/${AVATAR_ID}/telegram_webhook_secret/default`;

  try {
    const response = await secretsClient.send(new GetSecretValueCommand({
      SecretId: secretName,
    }));
    const value = response.SecretString || '';
    if (!value) return null;
    cachedWebhookSecret = { value, expiresAt: now + WEBHOOK_SECRET_TTL };
    return value;
  } catch {
    return null;
  }
}

/**
 * Initialize services (called once per Lambda cold start)
 */
async function initialize(): Promise<void> {
  if (stateService) return; // Already initialized

  stateService = createStateService(STATE_TABLE);
  activityService = createActivityService(ACTIVITY_TABLE);
  secretsService = createSecretsService();

  // Load avatar config from DynamoDB or environment
  avatarConfig = await stateService.getAvatarConfig(AVATAR_ID) || {
    id: AVATAR_ID,
    name: process.env.AVATAR_NAME || AVATAR_ID,
    version: '1.0.0',
    persona: '',
    platforms: {
      telegram: {
        enabled: true,
        botUsername: process.env.TELEGRAM_BOT_USERNAME || '',
        webhookPath: `/webhook/telegram/${AVATAR_ID}`,
      },
    },
    llm: {
      provider: 'openrouter',
      model: DEFAULT_LLM_MODEL,
      temperature: 0.8,
      maxTokens: 1024,
    },
    media: {
      image: { provider: 'replicate', model: 'black-forest-labs/flux-schnell' },
    },
    scheduling: {},
    behavior: {
      responseDelayMs: [1000, 3000],
      typingIndicator: true,
      ignoreBots: true,
      cooldownMinutes: 5,
      maxContextMessages: 20,
    },
    tools: ['send_message', 'react', 'ignore', 'wait', 'take_selfie'],
    secrets: ['TELEGRAM_BOT_TOKEN'],
  };

  // Get Telegram bot token
  const secrets = await secretsService.getSecretJson<Record<string, string>>(
    process.env.SECRETS_ARN || `swarm/${AVATAR_ID}/secrets`
  );

  telegramAdapter = new TelegramAdapter(avatarConfig, secrets.TELEGRAM_BOT_TOKEN);
}

/**
 * Lambda handler
 */
export async function handler(
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> {
  const startTime = Date.now();

  const headersLower = Object.fromEntries(
    Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v || ''])
  );
  const traceId = headersLower['x-trace-id'] || randomUUID();

  logger.setContext({
    avatarId: AVATAR_ID,
    platform: 'telegram',
    requestId: context.awsRequestId,
    traceId,
  });

  logger.info('Telegram webhook received', {
    event: 'request_received',
    subsystem: 'telegram',
  });

  try {
    await initialize();

    // Parse and verify request
    const body = event.body
      ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf-8')
      : Buffer.from('');
    const headers = headersLower;

    const webhookSecret = await getWebhookSecret();
    if (webhookSecret) {
      const providedSecret = headers['x-telegram-bot-api-secret-token'];
      const providedBuf = Buffer.from(providedSecret || '');
      const expectedBuf = Buffer.from(webhookSecret);
      const secretValid = providedBuf.length === expectedBuf.length &&
        timingSafeEqual(providedBuf, expectedBuf);

      if (!secretValid) {
        logger.warn('Invalid webhook secret', {
          event: 'validation_error',
          subsystem: 'telegram',
          reason: 'invalid_secret',
        });
        return { statusCode: 401, body: 'Unauthorized' };
      }
    } else {
      const isValid = await telegramAdapter.verifyRequest(body, headers);
      if (!isValid) {
        logger.warn('Invalid request signature', {
          event: 'validation_error',
          subsystem: 'telegram',
          reason: 'invalid_signature',
        });
        return { statusCode: 401, body: 'Unauthorized' };
      }
    }

    // Parse the message
    let update;
    try {
      update = JSON.parse(body.toString());
    } catch (parseError) {
      logger.error('Failed to parse Telegram update as JSON', parseError, {
        event: 'parse_error',
        subsystem: 'telegram',
      });
      return { statusCode: 400, body: 'Invalid JSON' };
    }
    const envelope = await telegramAdapter.parseMessage(update);

    if (!envelope) {
      // Valid update but not a message we handle (e.g., inline query)
      return { statusCode: 200, body: 'OK' };
    }

    envelope.traceId = traceId;

    // Log received message
    await activityService.logMessageReceived(
      AVATAR_ID,
      'telegram',
      envelope.sender.displayName || envelope.sender.username || 'Unknown',
      envelope.content.text || '[media]'
    );

    // Check idempotency
    const isNewMessage = await stateService.checkAndSetIdempotency(
      envelope.metadata.idempotencyKey
    );

    if (!isNewMessage) {
      logger.info('Duplicate message, skipping', { messageId: envelope.messageId });
      return { statusCode: 200, body: 'OK' };
    }

    // Evaluate if we should respond
    const evaluator = createMessageEvaluator(avatarConfig, stateService, {
      botUsernames: [avatarConfig.platforms.telegram?.botUsername || ''],
    });

    const evaluation = await evaluator.evaluate(envelope);

    if (!evaluation.shouldRespond) {
      logger.info('Not responding', { reason: evaluation.reason });
      return { statusCode: 200, body: 'OK' };
    }

    // Update envelope with evaluation results
    envelope.metadata.shouldRespond = evaluation.shouldRespond;
    envelope.metadata.responseReason = evaluation.reason;
    envelope.metadata.priority = evaluation.priority;

    // Add message to channel state
    await stateService.addMessageToChannel(
      AVATAR_ID,
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
      envelope.metadata.chatType,
      envelope.metadata.chatTitle
    );

    // Queue for response generation
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
      MessageGroupId: `${AVATAR_ID}#${envelope.conversationId}`, // FIFO ordering by avatar+conversation
      MessageDeduplicationId: envelope.metadata.idempotencyKey,
    }));

    logger.info('Message queued for processing', {
      event: 'message_queued',
      subsystem: 'telegram',
      messageId: envelope.messageId,
      reason: evaluation.reason,
      durationMs: Date.now() - startTime,
    });

    // Return 200 immediately (async processing)
    return { statusCode: 200, body: 'OK' };

  } catch (error) {
    logger.error('Handler error', error, {
      event: 'handler_error',
      subsystem: 'telegram',
      durationMs: Date.now() - startTime,
    });
    
    // Log error to activity feed
    try {
      await activityService.logError(
        AVATAR_ID,
        'telegram',
        error instanceof Error ? error.message : String(error)
      );
    } catch {
      // Ignore activity logging errors
    }

    // Return 200 to prevent Telegram retries
    return { statusCode: 200, body: 'OK' };
  }
}
