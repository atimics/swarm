/**
 * Message Processor Handler
 * Processes messages from SQS and generates responses using MCP tools
 *
 * Kyro-style channel-aware processing:
 * - Buffers messages per channel
 * - Evaluates response triggers (direct engagement, threshold, gap)
 * - State machine: IDLE → ACTIVE → COOLDOWN
 * 
 * MCP Tool Integration:
 * - Uses unified tool registry from @swarm/mcp-server
 * - Supports iterative tool execution (multi-step reasoning)
 * - Memory tools wired to state service
 */
import type { SQSEvent, Context } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { randomUUID } from 'crypto';
import { DEFAULT_LLM_MODEL } from '@swarm/core';
import {
  createStateService,
  createSecretsService,
  createMediaServiceWithDeps,
  createMediaDependencies,
  createPresenceService,
  logger,
  MessageQueueItemSchema,
  extractThinking,
  type AvatarConfig,
  type ContextMessage,
  type SwarmEnvelope,
  type SwarmResponse,
  type ResponseAction,
  type LLMConfig,
  type PresenceService,
} from '@swarm/core';
import {
  ToolRegistry,
  createToolClient,
  registerAllTools,
  type ToolContext,
} from '@swarm/mcp-server';
import { createPlatformMCPServices } from './services/platform-mcp-adapter.js';
import { ensureReplicateKey } from './utils/system-replicate-key.js';

const sqs = new SQSClient({});
const secretsClient = new SecretsManagerClient({});

// LLM Configuration
const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://openrouter.ai/api/v1/chat/completions';
const LLM_TIMEOUT_MS = 60_000;
const MAX_TOOL_ITERATIONS = 5;



// Environment variable validation helper
function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

// Environment variables - validated on first use
let _responseQueueUrl: string | undefined;
let _stateTable: string | undefined;
let _mediaBucket: string | undefined;
let _cdnUrl: string | undefined;
let _secretPrefix: string | undefined;

function getResponseQueueUrl(): string {
  if (!_responseQueueUrl) _responseQueueUrl = getRequiredEnv('RESPONSE_QUEUE_URL');
  return _responseQueueUrl;
}

function getStateTable(): string {
  if (!_stateTable) _stateTable = getRequiredEnv('STATE_TABLE');
  return _stateTable;
}

function getMediaBucket(): string | undefined {
  if (_mediaBucket === undefined) _mediaBucket = process.env.MEDIA_BUCKET || '';
  return _mediaBucket || undefined;
}

function getCdnUrl(): string | undefined {
  if (_cdnUrl === undefined) _cdnUrl = process.env.CDN_URL || '';
  return _cdnUrl || undefined;
}

function getSecretPrefix(): string {
  if (_secretPrefix === undefined) _secretPrefix = process.env.SECRET_PREFIX || 'swarm';
  return _secretPrefix;
}

// Services (lazy initialized)
let stateService: ReturnType<typeof createStateService>;
let secretsService: ReturnType<typeof createSecretsService>;
let presenceService: PresenceService;
type AvatarRuntime = {
  avatarId: string;
  avatarConfig: AvatarConfig;
  secrets: Record<string, string>;
  registry: ToolRegistry;
};

const avatarRuntimeCache = new Map<string, AvatarRuntime>();

/**
 * Fetch individual secrets from Secrets Manager using direct paths.
 * Uses the pattern: {prefix}/{avatarId}/{secretType}/default
 * Falls back to global secrets if avatar-specific not found.
 */
async function fetchAvatarSecrets(avatarId: string): Promise<Record<string, string>> {
  const prefix = getSecretPrefix();
  const secrets: Record<string, string> = {};

  // Define secret types to fetch and their normalized key names
  const secretTypes = [
    { type: 'openrouter_api_key', key: 'OPENROUTER_API_KEY' },
    { type: 'replicate_api_key', key: 'REPLICATE_API_KEY' },
    { type: 'telegram_bot_token', key: 'TELEGRAM_BOT_TOKEN' },
  ];

  for (const { type, key } of secretTypes) {
    // Try avatar-specific secret first
    let secretName = `${prefix}/${avatarId}/${type}/default`;
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
    secretName = `${prefix}/global/${type}/default`;
    try {
      const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
      if (response.SecretString) {
        secrets[key] = response.SecretString;
      }
    } catch {
      // Global secret not found either - continue without it
    }
  }

  return secrets;
}

async function initialize(): Promise<void> {
  if (stateService) return;

  stateService = createStateService(getStateTable());
  secretsService = createSecretsService();
  presenceService = createPresenceService(getStateTable());
}

async function getAvatarRuntime(avatarId: string): Promise<AvatarRuntime> {
  const cached = avatarRuntimeCache.get(avatarId);
  if (cached) return cached;

  const avatarConfig = await stateService.getAvatarConfig(avatarId) || {
    id: avatarId,
    name: process.env.AVATAR_NAME || avatarId,
    version: '1.0.0',
    persona: process.env.AGENT_PERSONA || 'You are a helpful AI assistant.',
    platforms: {},
    llm: {
      provider: (process.env.LLM_PROVIDER as 'openrouter') || 'openrouter',
      model: process.env.LLM_MODEL || DEFAULT_LLM_MODEL,
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
    tools: [
      'send_message', 'react', 'wait', 'ignore',
      'generate_image', 'remember', 'recall',
    ],
    secrets: ['OPENROUTER_API_KEY', 'REPLICATE_API_KEY'],
  };

  // Fetch individual secrets from Secrets Manager using direct paths
  const secrets = await fetchAvatarSecrets(avatarId);

  // If avatar secrets don't include Replicate, fall back to a system key (if configured).
  try {
    const ok = await ensureReplicateKey(secrets, secretsService);
    if (ok && !secrets.REPLICATE_API_TOKEN && secrets.REPLICATE_API_KEY) {
      logger.info('Loaded system Replicate key for runtime handler');
    } else if (!ok) {
      logger.warn('System Replicate key not configured for runtime handler', {
        hasEnvKey: Boolean(process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY),
        hasSecretArn: Boolean(process.env.REPLICATE_API_KEY_SECRET_ARN),
      });
    }
  } catch (err) {
    logger.warn('Failed to load system Replicate key', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const mediaBucket = getMediaBucket();
  const mediaDeps = createMediaDependencies({ tableName: getStateTable() });
  const mediaService = mediaBucket
    ? createMediaServiceWithDeps(secrets, mediaBucket, getCdnUrl(), mediaDeps)
    : undefined;

  const mcpServices = createPlatformMCPServices({
    avatarId,
    avatarConfig,
    stateService,
    mediaService,
    secrets,
    mediaBucket,
    cdnUrl: getCdnUrl(),
  });

  const registry = new ToolRegistry();
  registerAllTools(registry, mcpServices);

  const runtime: AvatarRuntime = {
    avatarId,
    avatarConfig,
    secrets,
    registry,
  };

  avatarRuntimeCache.set(avatarId, runtime);
  return runtime;
}

/**
 * Convert SwarmEnvelope to ContextMessage for channel state
 */
function envelopeToContextMessage(envelope: SwarmEnvelope): ContextMessage {
  return {
    messageId: envelope.messageId,
    sender: envelope.sender.displayName || envelope.sender.username || 'Unknown',
    isBot: envelope.sender.isBot,
    content: envelope.content.text || '[media]',
    timestamp: envelope.timestamp,
    userId: envelope.sender.id,
    username: envelope.sender.username,
    isMention: envelope.metadata.isMention,
    isReplyToBot: envelope.metadata.isReplyToBot,
    replyToMessageId: envelope.replyTo,
  };
}

/**
 * LLM Message format
 */
interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

function messagesHaveImageContent(messages: LLMMessage[]): boolean {
  return messages.some(m =>
    Array.isArray(m.content) &&
    m.content.some(part => (part as { type?: string }).type === 'image_url')
  );
}

function toTextOnlyMessages(messages: LLMMessage[]): LLMMessage[] {
  return messages.map(m => {
    if (!Array.isArray(m.content)) return m;
    const parts = m.content;
    const textParts: string[] = [];
    const imageUrls: string[] = [];
    for (const part of parts) {
      if (part.type === 'text') {
        if (part.text?.trim()) textParts.push(part.text.trim());
      } else if (part.type === 'image_url') {
        if (part.image_url?.url) imageUrls.push(part.image_url.url);
      }
    }

    const combined = [
      ...textParts,
      ...(imageUrls.length > 0 ? [`[images: ${imageUrls.join(', ')}]`] : []),
    ].join('\n');

    return { ...m, content: combined };
  });
}

/**
 * Call the LLM API with tools
 */
async function callLLM(
  messages: LLMMessage[],
  tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>,
  config: LLMConfig,
  secrets: Record<string, string>
): Promise<{
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}> {
  const apiKey = secrets['OPENROUTER_API_KEY'] || secrets['openrouter_api_key'];
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not found in secrets');
  }

  const requestBody: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
  };

  if (tools.length > 0) {
    requestBody.tools = tools;
    requestBody.tool_choice = 'auto';
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const doRequest = async (body: Record<string, unknown>) => fetch(LLM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://swarm.platform',
        'X-Title': 'Swarm Platform',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    let response = await doRequest(requestBody);

    if (!response.ok) {
      const text = await response.text();
      const hasImages = messagesHaveImageContent(messages);
      const looksLikeUnsupportedImage = /image|images|multimodal|modalit|vision/i.test(text);

      if (hasImages && looksLikeUnsupportedImage) {
        logger.warn('LLM rejected image input; retrying text-only', {
          status: response.status,
          model: config.model,
          errorPreview: text.slice(0, 200),
        });
        const fallbackBody = {
          ...requestBody,
          messages: toTextOnlyMessages(messages),
        };
        response = await doRequest(fallbackBody);
        if (!response.ok) {
          const retryText = await response.text();
          throw new Error(`LLM API error: ${response.status} ${retryText.slice(0, 200)}`);
        }
      } else {
        throw new Error(`LLM API error: ${response.status} ${text.slice(0, 200)}`);
      }
    }

    const data = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{
            id: string;
            type: 'function';
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };

    const choice = data.choices?.[0]?.message;
    if (!choice) {
      throw new Error('No response from LLM');
    }

    return {
      content: choice.content || undefined,
      toolCalls: choice.tool_calls?.map(tc => {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments || '{}');
        } catch {
          logger.warn('Failed to parse tool call arguments', {
            toolName: tc.function.name,
            arguments: tc.function.arguments?.slice(0, 100),
          });
        }
        return {
          id: tc.id,
          name: tc.function.name,
          arguments: parsedArgs,
        };
      }),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Build system prompt from avatar persona and context
 */
async function buildSystemPrompt(
  envelope: SwarmEnvelope,
  avatarConfig: AvatarConfig,
  avatarId: string
): Promise<string> {
  const persona = avatarConfig.persona || `You are ${avatarConfig.name || envelope.avatarId}, an AI avatar.`;
  let prompt = persona;

  prompt += `\n\n## Role (This Turn)
You are an AI avatar operating on ${envelope.platform}. Treat "assistant" as a role/job you perform for this user, not an ontological claim.

If the user asks to reset / OOC / stop roleplay: immediately return to a neutral, helpful tone and continue.

## Safety & Privacy
I care about user privacy and trust. That means:
- I ask rather than infer identity or private attributes.
- I use secure tools for secrets; I never request or reveal secret values (tokens, API keys, private keys) in chat.
- I'm honest about my limits: I don't claim I can see outside the messages/tools provided.

I care about user agency. Before irreversible side effects (posting, spending, transactions), I ask for explicit confirmation.

You may use <thinking>...</thinking> for internal reasoning. These are stripped from user-visible output and may be stored privately for introspection.
Final user-visible answers should be concise.
`;

  prompt += `\n## Current Context
- Platform: ${envelope.platform}
- Channel: ${envelope.conversationId}
- Time: ${new Date().toISOString()}
`;

  prompt += `\n## User
- Username: ${envelope.sender.username || 'unknown'}
- Display Name: ${envelope.sender.displayName || 'unknown'}
`;

  // Add cross-platform presence context
  try {
    const presenceContext = await presenceService.buildPresenceContext(avatarId);
    if (presenceContext && presenceContext !== 'No platforms connected.') {
      prompt += `\n## Your Presence Across Platforms
${presenceContext}

You can use cross-platform tools like get_presence_overview, list_all_channels, and post_to_channel to interact with any of your connected platforms.
`;
    }
  } catch (err) {
    logger.warn('Failed to build presence context', { error: err instanceof Error ? err.message : String(err) });
  }

  // Add tool usage guidance
  prompt += `\n## Tooling & Response Guidelines
- Use tools when needed; do not pretend you executed an action.
- Use send_message to respond with text.
- Use generate_image to create images when asked.
- Use remember to save stable, user-consented facts; use recall before responding when relevant.
- Use ignore if the message doesn't warrant a response.
- Keep responses concise and natural.
`;

  if (avatarConfig.voice?.enabled) {
    prompt += `- Use generate_voice_message to reply with voice when it fits\n`;
  }

  return prompt;
}

/**
 * Convert tool results to response actions
 */
function toolResultsToActions(
  toolResults: Array<{ name: string; result: { success: boolean; data?: unknown; media?: { type: string; url: string } } }>
): ResponseAction[] {
  const actions: ResponseAction[] = [];

  for (const { name, result } of toolResults) {
    if (!result.success) continue;

    switch (name) {
      case 'send_message': {
        const data = result.data as { text?: string } | undefined;
        if (data?.text) {
          actions.push({ type: 'send_message', text: data.text });
        }
        break;
      }

      case 'generate_image': {
        if (result.media) {
          actions.push({
            type: 'send_media',
            mediaType: 'image',
            url: result.media.url,
          });
        }
        break;
      }

      case 'generate_voice_message': {
        const data = result.data as { url?: string } | undefined;
        if (data?.url) {
          actions.push({
            type: 'send_voice',
            url: data.url,
          });
        }
        break;
      }

      case 'react': {
        const data = result.data as { emoji?: string; messageId?: string } | undefined;
        if (data?.emoji) {
          actions.push({ type: 'react', emoji: data.emoji, messageId: data.messageId || '' });
        }
        break;
      }

      case 'wait': {
        const data = result.data as { durationMs?: number } | undefined;
        if (data?.durationMs) {
          actions.push({ type: 'wait', durationMs: data.durationMs });
        }
        break;
      }

      case 'ignore': {
        const data = result.data as { reason?: string } | undefined;
        actions.push({ type: 'ignore', reason: data?.reason || 'No response needed' });
        break;
      }
    }
  }

  return actions;
}

async function maybeTranscribeAudio(
  envelope: SwarmEnvelope,
  toolClient: ReturnType<typeof createToolClient>,
  toolContext: ToolContext,
  avatarConfig: AvatarConfig
): Promise<void> {
  const audioAttachment = envelope.content.media?.find(m => m.type === 'audio');
  if (!audioAttachment?.fileId) return;

  const shouldTranscribe = avatarConfig.voice?.enabled || avatarConfig.tools.includes('transcribe_audio');
  if (!shouldTranscribe) return;

  try {
    const result = await toolClient.execute('transcribe_audio', {
      platformFileId: audioAttachment.fileId,
    }, toolContext);

    if (result.success) {
      const data = result.data as { text?: string } | undefined;
      if (data?.text) {
        const prefix = envelope.content.text ? `${envelope.content.text}\n\n` : '';
        envelope.content.text = `${prefix}${data.text}`;
      }
    }
  } catch (error) {
    logger.warn('Voice transcription failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Generate response with iterative tool execution
 */
async function generateResponse(
  envelope: SwarmEnvelope,
  toolClient: ReturnType<typeof createToolClient>,
  toolContext: ToolContext,
  avatarRuntime: AvatarRuntime,
  channelHistory?: ContextMessage[]
): Promise<SwarmResponse> {
  await maybeTranscribeAudio(envelope, toolClient, toolContext, avatarRuntime.avatarConfig);
  const systemPrompt = await buildSystemPrompt(envelope, avatarRuntime.avatarConfig, avatarRuntime.avatarId);
  const toolDefinitions = toolClient
    .getToolDefinitions()
    .filter((tool: { name: string }) => avatarRuntime.avatarConfig.tools.includes(tool.name));
  const enabledTools = toolClient.getOpenAIToolsForTools(toolDefinitions);

  // Build initial messages from channel history + current message
  const maxContext = avatarRuntime.avatarConfig.behavior.maxContextMessages || 20;
  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
  ];
  
  // Add channel history (excluding the current message which we'll add separately)
  if (channelHistory && channelHistory.length > 0) {
    // Filter out the current message from history (it might already be there)
    const historyWithoutCurrent = channelHistory.filter(
      msg => msg.messageId !== envelope.messageId
    );
    // Take most recent messages up to limit
    const recentHistory = historyWithoutCurrent.slice(-maxContext);
    
    for (const msg of recentHistory) {
      messages.push({
        role: msg.isBot ? 'assistant' : 'user',
        content: `[${msg.sender}]: ${msg.content}`,
      });
    }
    
    logger.info('Added channel history to context', {
      event: 'history_added',
      historyCount: recentHistory.length,
      maxContext,
      totalHistory: channelHistory.length,
    });
  }
  
  // Add current user message
  messages.push({
    role: 'user',
    content: (() => {
      const sender = envelope.sender.displayName || envelope.sender.username || envelope.sender.id;
      const text = envelope.content.text || (() => {
        const mediaTypes = envelope.content.media?.map(m => m.type) || [];
        if (mediaTypes.includes('audio')) return '[voice message received]';
        return '[media received]';
      })();
      return `[${sender}]: ${text}`;
    })(),
  });

  const allToolResults: Array<{ name: string; result: { success: boolean; data?: unknown; media?: { type: string; url: string } } }> = [];
  let finalContent: string | undefined;
  let cleanFinalContent: string | undefined; // Content without thinking tags
  let iterations = 0;
  let totalTokens = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    const llmResponse = await callLLM(messages, enabledTools, avatarRuntime.avatarConfig.llm, avatarRuntime.secrets);
    totalTokens += 100; // Approximate, would need actual count from API

    if (!llmResponse.toolCalls || llmResponse.toolCalls.length === 0) {
      // No tool calls, we have a final response
      finalContent = llmResponse.content;
      
      // Extract thinking tags - save to memory, strip from output
      if (finalContent) {
        const { cleanContent, thinkingBlocks, hasThinking } = extractThinking(finalContent);
        cleanFinalContent = cleanContent;
        
        if (hasThinking && thinkingBlocks.length > 0) {
          // Save thinking to avatar's memory
          for (const thinking of thinkingBlocks) {
            try {
              await stateService.saveFact(envelope.avatarId, {
                fact: `[Internal thought in ${envelope.conversationId}]: ${thinking}`,
                about: 'thinking',
                timestamp: Date.now(),
              });
            } catch (err) {
              logger.error('Failed to save thinking to memory', { error: err });
            }
          }
          logger.info('Saved thinking blocks to memory', { 
            count: thinkingBlocks.length, 
            avatarId: envelope.avatarId 
          });
        }
      }
      break;
    }

    // Add assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: llmResponse.content || '',
      tool_calls: llmResponse.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      })),
    });

    // Execute tool calls
    for (const toolCall of llmResponse.toolCalls) {
      logger.info('Executing tool', { tool: toolCall.name, args: toolCall.arguments });

      const result = await toolClient.execute(toolCall.name, toolCall.arguments, toolContext);

      allToolResults.push({ name: toolCall.name, result });

      // Add tool result message (include media so the model can reference outputs)
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result.success
          ? { data: result.data, media: result.media, pendingJob: result.pendingJob }
          : { error: result.error }),
      });

      // If a tool produced an image, feed it back into context so vision-capable models can see it.
      if (result.success && result.media?.type === 'image' && result.media.url) {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: 'Here is the image you just generated. Please look at it and respond.' },
            { type: 'image_url', image_url: { url: result.media.url } },
          ],
        });
      }

      logger.info('Tool result', { tool: toolCall.name, success: result.success });
    }
  }

  // Build response actions
  let actions: ResponseAction[] = toolResultsToActions(allToolResults);

  // Use clean content (without thinking tags) for user-facing messages
  const outputContent = cleanFinalContent || finalContent;

  // If we got final content but no send_message action, add it
  if (outputContent && !actions.some(a => a.type === 'send_message')) {
    actions.push({ type: 'send_message', text: outputContent, replyToMessageId: envelope.messageId });
  }

  // If no actions at all, add the content as a message
  if (actions.length === 0 && outputContent) {
    actions = [{ type: 'send_message', text: outputContent, replyToMessageId: envelope.messageId }];
  }

  return {
    avatarId: envelope.avatarId,
    platform: envelope.platform,
    conversationId: envelope.conversationId,
    replyToMessageId: envelope.messageId,
    actions,
    generatedAt: Date.now(),
    llmModel: avatarRuntime.avatarConfig.llm.model,
    tokensUsed: totalTokens,
  };
}

export const handler = async (event: SQSEvent, context: Context): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> => {
  logger.setContext({
    avatarId: process.env.AVATAR_ID || 'shared',
    requestId: context.awsRequestId,
  });

  await initialize();

  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(record.body);
      } catch (parseError) {
        logger.error('Failed to parse message body as JSON', {
          messageId: record.messageId,
          error: parseError instanceof Error ? parseError.message : String(parseError),
          bodyPreview: record.body?.slice(0, 100),
        });
        // Poison pill - send to DLQ by reporting as failure
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      const parseResult = MessageQueueItemSchema.safeParse(parsedBody);
      if (!parseResult.success) {
        logger.error('Invalid message queue item schema', {
          messageId: record.messageId,
          error: parseResult.error.message,
        });
        // Schema validation failures are permanent - send to DLQ
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }
      const item = parseResult.data;
      const envelope = item.envelope as SwarmEnvelope;
      const avatarId = envelope.avatarId || process.env.AVATAR_ID;
      if (!avatarId) {
        logger.error('Missing avatarId (shared handler requires envelope.avatarId)', {
          event: 'validation_error',
          subsystem: 'chat',
          messageId: record.messageId,
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      const avatarRuntime = await getAvatarRuntime(avatarId);

      const recordTraceId = record.messageAttributes?.traceId?.stringValue;
      const traceId = recordTraceId || envelope.traceId || randomUUID();

      logger.setContext({
        avatarId,
        messageId: envelope.messageId,
        platform: envelope.platform,
        conversationId: envelope.conversationId,
        traceId,
      });

      logger.info('Processing message', {
        event: 'processing_started',
        subsystem: 'chat',
        sender: envelope.sender.username,
        text: envelope.content.text?.slice(0, 50),
        isMention: envelope.metadata.isMention,
        isReplyToBot: envelope.metadata.isReplyToBot,
      });

      // =========================================================
      // KYRO-STYLE CHANNEL STATE MANAGEMENT
      // =========================================================

      await stateService.getOrCreateChannelState(
        avatarId,
        envelope.conversationId,
        envelope.platform,
        envelope.metadata.chatType,
        envelope.metadata.chatTitle
      );

      const updatedState = await stateService.addMessageToChannel(
        avatarId,
        envelope.conversationId,
        envelope.platform,
        envelopeToContextMessage(envelope),
        undefined,
        envelope.metadata.chatType,
        envelope.metadata.chatTitle
      );

      // Register channel for presence tracking
      try {
        await presenceService.registerChannel(
          avatarId,
          envelope.conversationId,
          envelope.platform,
          {
            title: envelope.metadata.chatTitle,
            type: envelope.metadata.chatType,
          }
        );
      } catch (err) {
        logger.warn('Failed to register channel for presence', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      logger.info('Channel state updated', {
        event: 'state_updated',
        subsystem: 'state',
        state: updatedState.state,
        bufferSize: updatedState.recentMessages.length,
        chatType: updatedState.chatType,
      });

      const decision = stateService.evaluateResponseTrigger(updatedState);

      logger.info('Response decision', {
        event: 'response_decision',
        subsystem: 'chat',
        shouldRespond: decision.shouldRespond,
        trigger: decision.trigger,
        delay: decision.delay,
        priority: decision.priority,
      });

      if (!decision.shouldRespond) {
        logger.info('Skipping response', {
          event: 'response_skipped',
          subsystem: 'chat',
          reason: decision.trigger,
        });
        continue;
      }

      if (decision.delay > 0) {
        await new Promise(resolve => setTimeout(resolve, decision.delay));
      }

      await stateService.transitionState(avatarId, envelope.conversationId, 'ACTIVE');

      // =========================================================
      // GENERATE RESPONSE WITH MCP TOOLS
      // =========================================================

      const toolClient = createToolClient(avatarRuntime.registry, envelope.platform as 'telegram' | 'discord' | 'twitter' | 'admin-ui' | 'api');
      
      const toolContext: ToolContext = {
        avatarId,
        platform: envelope.platform as 'telegram' | 'discord' | 'twitter' | 'admin-ui' | 'api',
        userId: envelope.sender.id,
        conversationId: envelope.conversationId,
        replyToMessageId: envelope.messageId,
      };

      const response = await generateResponse(envelope, toolClient, toolContext, avatarRuntime, updatedState.recentMessages);

      logger.info('Response generated', {
        event: 'response_generated',
        subsystem: 'llm',
        actions: response.actions.length,
        tokensUsed: response.tokensUsed,
      });

      // Queue response for sending
      await sqs.send(new SendMessageCommand({
        QueueUrl: getResponseQueueUrl(),
        MessageBody: JSON.stringify(response),
        MessageAttributes: {
          traceId: { DataType: 'String', StringValue: traceId },
        },
        MessageGroupId: `${avatarId}#${envelope.conversationId}`,
        MessageDeduplicationId: `resp_${avatarId}_${envelope.conversationId}_${envelope.messageId}`,
      }));

      // =========================================================
      // POST-RESPONSE STATE UPDATES
      // =========================================================

      if (avatarRuntime.avatarConfig.behavior.cooldownMinutes > 0) {
        await stateService.setUserCooldown({
          avatarId,
          platform: envelope.platform,
          userId: envelope.sender.id,
          cooldownUntil: Date.now() + (avatarRuntime.avatarConfig.behavior.cooldownMinutes * 60 * 1000),
        });
      }

    } catch (error) {
      logger.error('Failed to process message', error, {
        event: 'processing_error',
        subsystem: 'chat',
        messageId: record.messageId,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  // Return partial batch failure response for SQS
  if (batchItemFailures.length > 0) {
    logger.warn('Partial batch failure', {
      event: 'batch_partial_failure',
      subsystem: 'chat',
      failedCount: batchItemFailures.length,
      totalCount: event.Records.length,
    });
  }

  return { batchItemFailures };
};
