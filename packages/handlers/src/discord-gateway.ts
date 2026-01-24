/**
 * Discord Gateway Worker
 * Maintains a persistent gateway connection to ingest Discord messages.
 */
import WebSocket from 'ws';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import {
  DiscordAdapter,
  createStateService,
  createSecretsService,
  createActivityService,
  createMessageEvaluator,
  logger,
  DEFAULT_LLM_MODEL,
  type AvatarConfig,
  type SwarmEnvelope,
} from '@swarm/core';

const sqs = new SQSClient({});

const DEFAULT_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const DEFAULT_INTENTS =
  1 | // GUILDS
  512 | // GUILD_MESSAGES
  4096 | // DIRECT_MESSAGES
  32768; // MESSAGE_CONTENT

const MESSAGE_QUEUE_URL = getRequiredEnv('MESSAGE_QUEUE_URL');
const STATE_TABLE = getRequiredEnv('STATE_TABLE');
const ACTIVITY_TABLE = getRequiredEnv('ACTIVITY_TABLE');
const AVATAR_ID = getRequiredEnv('AVATAR_ID');

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string;
}

interface GatewayHello {
  heartbeat_interval: number;
}

interface GatewayReady {
  session_id: string;
  resume_gateway_url?: string;
  user: { id: string; username: string };
}

let stateService: ReturnType<typeof createStateService>;
let activityService: ReturnType<typeof createActivityService>;
let secretsService: ReturnType<typeof createSecretsService>;
let discordAdapter: DiscordAdapter;
let avatarConfig: AvatarConfig;
let evaluator: ReturnType<typeof createMessageEvaluator>;
let botUserId: string | undefined;
let botUsername: string | undefined;

async function initialize(): Promise<void> {
  if (stateService) return;

  stateService = createStateService(STATE_TABLE);
  activityService = createActivityService(ACTIVITY_TABLE);
  secretsService = createSecretsService();

  avatarConfig = await stateService.getAvatarConfig(AVATAR_ID) || {
    id: AVATAR_ID,
    name: process.env.AVATAR_NAME || AVATAR_ID,
    version: '1.0.0',
    persona: '',
    platforms: {
      discord: {
        enabled: true,
        mode: 'bot',
        respondToMentions: true,
        respondInDMs: true,
        useGateway: true,
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
    secrets: ['DISCORD_BOT_TOKEN'],
  };

  const secrets = await secretsService.getSecretJson<Record<string, string>>(
    process.env.SECRETS_ARN || `swarm/${AVATAR_ID}/secrets`
  );

  discordAdapter = new DiscordAdapter(avatarConfig, {
    botToken: secrets.DISCORD_BOT_TOKEN || secrets.discord_bot_token,
    applicationId: avatarConfig.platforms.discord?.applicationId,
    publicKey: avatarConfig.platforms.discord?.publicKey,
    webhookUrl: avatarConfig.platforms.discord?.webhookUrl,
    webhookId: avatarConfig.platforms.discord?.webhookId,
    webhookToken: avatarConfig.platforms.discord?.webhookToken,
  });

  updateEvaluator();
}

function updateEvaluator(): void {
  evaluator = createMessageEvaluator(avatarConfig, stateService, {
    botUsernames: botUsername ? [botUsername] : [],
    botUserIds: botUserId ? [botUserId] : [],
  });
}

async function handleEnvelope(envelope: SwarmEnvelope): Promise<void> {
  const traceId = envelope.traceId || randomUUID();
  envelope.traceId = traceId;

  logger.setContext({
    avatarId: AVATAR_ID,
    platform: 'discord',
    messageId: envelope.messageId,
    conversationId: envelope.conversationId,
    traceId,
  });

  await activityService.logMessageReceived(
    AVATAR_ID,
    'discord',
    envelope.sender.displayName || envelope.sender.username || 'Unknown',
    envelope.content.text || '[message]'
  );

  const isNewMessage = await stateService.checkAndSetIdempotency(
    envelope.metadata.idempotencyKey
  );

  if (!isNewMessage) {
    logger.info('Duplicate Discord message, skipping', { messageId: envelope.messageId });
    return;
  }

  const evaluation = await evaluator.evaluate(envelope);
  if (!evaluation.shouldRespond) {
    logger.info('Not responding', { reason: evaluation.reason });
    return;
  }

  envelope.metadata.shouldRespond = evaluation.shouldRespond;
  envelope.metadata.responseReason = evaluation.reason;
  envelope.metadata.priority = evaluation.priority;

  await stateService.addMessageToChannel(
    AVATAR_ID,
    envelope.conversationId,
    'discord',
    {
      messageId: envelope.messageId,
      sender: envelope.sender.displayName || envelope.sender.username || envelope.sender.id,
      isBot: envelope.sender.isBot,
      content: envelope.content.text || '[message]',
      timestamp: envelope.timestamp,
    }
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
      traceId: {
        DataType: 'String',
        StringValue: traceId,
      },
    },
    MessageGroupId: `${AVATAR_ID}#${envelope.conversationId}`,
    MessageDeduplicationId: envelope.metadata.idempotencyKey,
  }));
}

class DiscordGateway {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private reconnectAttempts = 0;
  private shouldResume = false;

  constructor(
    private readonly token: string,
    private readonly intents: number
  ) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    const gatewayUrl = this.resumeGatewayUrl
      ? `${this.resumeGatewayUrl}?v=10&encoding=json`
      : DEFAULT_GATEWAY_URL;

    logger.info('Connecting to Discord gateway', { gatewayUrl });
    this.ws = new WebSocket(gatewayUrl);

    this.ws.on('open', () => {
      logger.info('Discord gateway connected', { resume: this.shouldResume });
    });

    this.ws.on('message', async (data: WebSocket.RawData) => {
      try {
        const payload = JSON.parse(data.toString()) as GatewayPayload;
        if (typeof payload.s === 'number') {
          this.sequence = payload.s;
        }
        await this.handlePayload(payload);
      } catch (error) {
        logger.error('Failed to parse gateway payload', error);
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      logger.warn('Discord gateway closed', { code, reason: reason.toString() });
      this.scheduleReconnect();
    });

    this.ws.on('error', (error: Error) => {
      logger.error('Discord gateway error', error);
    });
  }

  private async handlePayload(payload: GatewayPayload): Promise<void> {
    switch (payload.op) {
      case 10:
        this.handleHello(payload.d as GatewayHello);
        return;
      case 11:
        return;
      case 0:
        await this.handleDispatch(payload.t, payload.d);
        return;
      case 1:
        this.sendHeartbeat();
        return;
      case 7:
        logger.warn('Discord gateway requested reconnect');
        this.scheduleReconnect(true);
        return;
      case 9:
        logger.warn('Discord gateway invalid session');
        this.sessionId = null;
        this.sequence = null;
        this.resumeGatewayUrl = null;
        this.scheduleReconnect(false);
        return;
      default:
        return;
    }
  }

  private handleHello(hello: GatewayHello): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), hello.heartbeat_interval);
    this.sendHeartbeat();

    if (this.shouldResume && this.sessionId && this.sequence !== null) {
      this.resume();
    } else {
      this.identify();
    }
  }

  private async handleDispatch(eventType?: string, data?: unknown): Promise<void> {
    if (!eventType || !data) return;

    if (eventType === 'READY') {
      const ready = data as GatewayReady;
      this.sessionId = ready.session_id;
      this.resumeGatewayUrl = ready.resume_gateway_url || null;
      botUserId = ready.user.id;
      botUsername = ready.user.username;
      discordAdapter.setBotUserId(ready.user.id);
      updateEvaluator();
      this.reconnectAttempts = 0;
      this.shouldResume = true;
      logger.info('Discord gateway ready', { botUserId });
      return;
    }

    if (eventType === 'MESSAGE_CREATE') {
      const envelope = await discordAdapter.parseMessage(data);
      if (envelope) {
        await handleEnvelope(envelope);
      }
    }
  }

  private sendHeartbeat(): void {
    this.send({ op: 1, d: this.sequence });
  }

  private identify(): void {
    this.send({
      op: 2,
      d: {
        token: this.token,
        intents: this.intents,
        properties: {
          os: process.platform,
          browser: 'swarm',
          device: 'swarm',
        },
      },
    });
  }

  private resume(): void {
    if (!this.sessionId || this.sequence === null) {
      this.identify();
      return;
    }

    this.send({
      op: 6,
      d: {
        token: this.token,
        session_id: this.sessionId,
        seq: this.sequence,
      },
    });
  }

  private send(payload: GatewayPayload): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(payload));
  }

  private scheduleReconnect(resume = true): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.shouldResume = resume;
    const delay = Math.min(30_000, 1_000 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts += 1;
    setTimeout(() => this.connect(), delay);
  }
}

async function startGateway(): Promise<void> {
  await initialize();

  const secrets = await secretsService.getSecretJson<Record<string, string>>(
    process.env.SECRETS_ARN || `swarm/${AVATAR_ID}/secrets`
  );
  const botToken = secrets.DISCORD_BOT_TOKEN || secrets.discord_bot_token;
  if (!botToken) {
    throw new Error('DISCORD_BOT_TOKEN not configured');
  }

  const intents = Number(process.env.DISCORD_GATEWAY_INTENTS)
    || avatarConfig.platforms.discord?.intents
    || DEFAULT_INTENTS;

  const gateway = new DiscordGateway(`Bot ${botToken}`, intents);

  process.on('SIGTERM', () => gateway.stop());
  process.on('SIGINT', () => gateway.stop());

  gateway.start();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startGateway().catch((error) => {
    logger.error('Discord gateway failed to start', error);
    process.exit(1);
  });
}

export { startGateway };
