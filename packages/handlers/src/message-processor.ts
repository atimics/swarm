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
import { randomUUID } from 'crypto';
import { DEFAULT_AVATAR_CONFIG } from '@swarm/core';
import {
  createStateService,
  createSecretsService,
  createMediaServiceWithDeps,
  createMediaDependencies,
  createPresenceService,
  createChannelSummaryService,
  createCircuitBreaker,
  logger,
  MessageQueueItemSchema,
  extractThinking,
  // Unified prompt builder
  buildDynamicSystemPrompt,
  toolsToCategories,
  type ProcessorAvatarConfig,
  type RuntimeContext,
  type AvatarConfig,
  type ContextMessage,
  type SwarmEnvelope,
  type SwarmResponse,
  type ResponseAction,
  type LLMConfig,
  type PresenceService,
  type Platform,
} from '@swarm/core';
import {
  ToolRegistry,
  createToolClient,
  registerAllTools,
  type ToolContext,
} from '@swarm/mcp-server';
import { createPlatformMCPServices } from './services/platform-mcp-adapter.js';
import {
  checkAndIncrementMessageUsage,
  checkToolCallLimit,
  isMemoryWriteAllowed,
} from './services/entitlement-enforcement.js';
import { ensureReplicateKey } from './utils/system-replicate-key.js';
import { loadAvatarSecrets } from './utils/load-avatar-secrets.js';

const sqs = new SQSClient({});

// LLM Configuration
const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://openrouter.ai/api/v1/chat/completions';
// NOTE: The message processor Lambda timeout is set in infra; keep this below that value.
// Default increased to better handle slow OpenRouter responses in multi-agent channels.
const LLM_TIMEOUT_MS = Number.parseInt(process.env.LLM_TIMEOUT_MS || '', 10) || 90_000;
const MAX_TOOL_ITERATIONS = 5;

// Circuit breaker for LLM calls — trips after 3 consecutive failures,
// half-opens after 30s. Prevents burning Lambda concurrency on a down provider.
const llmCircuitBreaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000 });

/**
 * Parse XML-style function calls that some models output in their text content
 * instead of using proper tool_calls format.
 * 
 * Handles formats like:
 * 1. Full invoke format:
 *    <function_calls>
 *      <invoke name="send_message">
 *        <parameter name="text">Hello!</parameter>
 *      </invoke>
 *    </function_calls>
 * 
 * 2. Direct tool tag format:
 *    <send_message>Hello!</send_message>
 * 
 * Returns extracted tool calls and cleaned content (with XML removed).
 */
function parseXmlToolCalls(content: string): {
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  cleanedContent: string;
} {
  const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  let cleanedContent = content;
  
  // Known tool names that might appear as direct XML tags
  const knownTools = ['send_message', 'react', 'ignore', 'wait', 'generate_image', 'remember', 'recall', 'take_selfie'];
  
  // Pattern 1: Match <function_calls>...</function_calls> wrapper format
  const functionCallsPattern = /<(?:antml:)?function_calls>([\s\S]*?)<\/(?:antml:)?function_calls>/gi;
  let match: RegExpExecArray | null;
  
  while ((match = functionCallsPattern.exec(content)) !== null) {
    const block = match[1];
    
    // Extract <invoke> blocks
    const invokePattern = /<(?:antml:)?invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/(?:antml:)?invoke>/gi;
    let invokeMatch: RegExpExecArray | null;
    
    while ((invokeMatch = invokePattern.exec(block)) !== null) {
      const toolName = invokeMatch[1];
      const paramsBlock = invokeMatch[2];
      const args: Record<string, unknown> = {};
      
      // Extract <parameter> values
      const paramPattern = /<(?:antml:)?parameter\s+name=["']([^"']+)["']>([^<]*)<\/(?:antml:)?parameter>/gi;
      let paramMatch: RegExpExecArray | null;
      
      while ((paramMatch = paramPattern.exec(paramsBlock)) !== null) {
        const paramName = paramMatch[1];
        const paramValue = paramMatch[2].trim();
        
        try {
          args[paramName] = JSON.parse(paramValue);
        } catch {
          args[paramName] = paramValue;
        }
      }
      
      toolCalls.push({
        id: `xml_${randomUUID().slice(0, 8)}`,
        name: toolName,
        arguments: args,
      });
      
      logger.info('Parsed XML tool call from content (invoke format)', {
        toolName,
        args,
      });
    }
    
    // Remove the matched XML block from content
    cleanedContent = cleanedContent.replace(match[0], '').trim();
  }
  
  // Pattern 2: Match direct tool tags like <send_message>...</send_message>
  for (const toolName of knownTools) {
    const directPattern = new RegExp(`<${toolName}>([\\s\\S]*?)<\\/${toolName}>`, 'gi');
    let directMatch: RegExpExecArray | null;
    
    while ((directMatch = directPattern.exec(cleanedContent)) !== null) {
      const textContent = directMatch[1].trim();
      
      // For send_message, the content is the text parameter
      const args: Record<string, unknown> = toolName === 'send_message' 
        ? { text: textContent }
        : toolName === 'react'
          ? { emoji: textContent }
          : { value: textContent };
      
      toolCalls.push({
        id: `xml_${randomUUID().slice(0, 8)}`,
        name: toolName,
        arguments: args,
      });
      
      logger.info('Parsed XML tool call from content (direct tag format)', {
        toolName,
        args,
      });
      
      // Remove the matched tag from content
      cleanedContent = cleanedContent.replace(directMatch[0], '').trim();
    }
  }
  
  return { toolCalls, cleanedContent };
}

/**
 * Strip avatar name prefix from response if the model accidentally included it.
 * Models sometimes see `[Username]: message` in history and mimic the pattern.
 * This removes prefixes like `[Rati]:`, `[Chamuel 😇]:`, `Rati:`, etc.
 */
function stripAvatarNamePrefix(content: string, avatarName: string): string {
  if (!content || !avatarName) return content;
  
  // Try various prefix patterns the model might use
  const patterns = [
    // [Name]: format (with optional emoji/special chars)
    new RegExp(`^\\[${escapeRegex(avatarName)}[^\\]]*\\]:\\s*`, 'i'),
    // Name: format at start of message
    new RegExp(`^${escapeRegex(avatarName)}:\\s*`, 'i'),
  ];
  
  for (const pattern of patterns) {
    if (pattern.test(content)) {
      return content.replace(pattern, '').trim();
    }
  }
  
  return content;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
 * Delegates to the shared loadAvatarSecrets utility for consistent
 * fallback chains and naming conventions across all handlers.
 */
async function fetchAvatarSecrets(avatarId: string): Promise<Record<string, string>> {
  const prefix = getSecretPrefix();
  const secrets = await loadAvatarSecrets(secretsService, avatarId, prefix);

  logger.info('Fetched avatar secrets', {
    avatarId,
    hasOpenRouterKey: !!secrets.OPENROUTER_API_KEY,
    hasTwitterApiKey: !!secrets.TWITTER_API_KEY,
    hasTwitterApiSecret: !!secrets.TWITTER_API_SECRET,
    hasTwitterAccessToken: !!secrets.TWITTER_ACCESS_TOKEN,
    hasTwitterAccessSecret: !!secrets.TWITTER_ACCESS_SECRET,
  });

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
    ...DEFAULT_AVATAR_CONFIG,
    id: avatarId,
    name: process.env.AVATAR_NAME || avatarId,
    persona: process.env.AGENT_PERSONA || DEFAULT_AVATAR_CONFIG.persona,
    llm: {
      ...DEFAULT_AVATAR_CONFIG.llm,
      provider: (process.env.LLM_PROVIDER as 'openrouter') || DEFAULT_AVATAR_CONFIG.llm.provider,
      model: process.env.LLM_MODEL || DEFAULT_AVATAR_CONFIG.llm.model,
    },
    tools: [...DEFAULT_AVATAR_CONFIG.tools],
    secrets: [...DEFAULT_AVATAR_CONFIG.secrets],
  };

  // Back-compat + parity: if Twitter is enabled, ensure the runtime tool allowlist includes
  // the core Twitter interaction tools so automated replies can fetch context and act.
  // (We still keep explicit allowlisting; this just avoids "agentic" regressions from
  // older configs that only included a minimal tool set.)
  const effectiveTools = new Set<string>(avatarConfig.tools || []);
  if (avatarConfig.platforms?.twitter?.enabled) {
    [
      'twitter_status',
      'twitter_get_tweet',
      'twitter_get_mentions',
      'twitter_get_timeline',
      'twitter_reply',
      'twitter_post',
      'twitter_like',
      'twitter_unlike',
      'twitter_retweet',
      'twitter_unretweet',
      'twitter_quote',
      'twitter_get_activity_summary',
    ].forEach(t => effectiveTools.add(t));
  }

  // Enable gallery and core media tools for Telegram avatars
  if (avatarConfig.platforms?.telegram?.enabled) {
    [
      'get_my_gallery',
      'search_gallery',
      'send_gallery_image',
      'generate_image',
      'generate_video',
      'get_job_status',
      'list_jobs',
    ].forEach(t => effectiveTools.add(t));
  }

  if (effectiveTools.size !== (avatarConfig.tools || []).length) {
    avatarConfig.tools = Array.from(effectiveTools);
  }

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

  // Circuit breaker — fail fast when LLM provider is unhealthy
  if (!llmCircuitBreaker.canExecute()) {
    logger.warn('LLM circuit breaker is open, failing fast', {
      event: 'circuit_breaker_open',
      subsystem: 'llm',
      state: llmCircuitBreaker.state(),
      model: config.model,
    });
    throw new Error('LLM circuit breaker is open — provider unhealthy');
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

    // Parse proper tool_calls from the API response
    const apiToolCalls = choice.tool_calls?.map(tc => {
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
    }) || [];

    // Also check for XML-style tool calls in content (some models output these in text)
    let finalContent = choice.content || undefined;
    let xmlToolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
    
    if (finalContent && (finalContent.includes('<function_calls>') || finalContent.includes('<invoke'))) {
      const parsed = parseXmlToolCalls(finalContent);
      xmlToolCalls = parsed.toolCalls;
      finalContent = parsed.cleanedContent || undefined;
      
      if (xmlToolCalls.length > 0) {
        logger.info('Extracted XML tool calls from content', {
          count: xmlToolCalls.length,
          tools: xmlToolCalls.map(t => t.name),
        });
      }
    }

    // Combine API tool calls with any XML-parsed tool calls
    const allToolCalls = [...apiToolCalls, ...xmlToolCalls];

    llmCircuitBreaker.recordSuccess();

    return {
      content: finalContent,
      toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
    };
  } catch (error) {
    llmCircuitBreaker.recordFailure();
    if (llmCircuitBreaker.state() === 'open') {
      logger.error('LLM circuit breaker tripped to OPEN after consecutive failures', {
        event: 'circuit_breaker_tripped',
        subsystem: 'llm',
        model: config.model,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Build system prompt using unified prompt builder
 */
async function buildSystemPrompt(
  envelope: SwarmEnvelope,
  avatarConfig: AvatarConfig,
  avatarId: string,
  avatarSecrets: Record<string, string>
): Promise<string> {
  // Detect channel type for Telegram
  let channelType: 'private' | 'group' | 'supergroup' | 'channel' | undefined;
  if (envelope.platform === 'telegram') {
    // Telegram channel IDs: negative = group/supergroup, positive = private
    const channelId = envelope.conversationId;
    if (channelId.startsWith('-100')) {
      channelType = 'supergroup';
    } else if (channelId.startsWith('-')) {
      channelType = 'group';
    } else {
      channelType = 'private';
    }
  }

  // Get presence context
  let presenceContext: string | undefined;
  try {
    const ctx = await presenceService.buildPresenceContext(avatarId);
    if (ctx && ctx !== 'No platforms connected.') {
      presenceContext = ctx;
    }
  } catch (err) {
    logger.warn('Failed to build presence context', { error: err instanceof Error ? err.message : String(err) });
  }

  // Add cross-platform context (safe digest + home channel summary)
  let customContext: string | undefined;
  try {
    customContext = await buildCrossPlatformCustomContext({
      avatarId,
      avatarConfig,
      avatarSecrets,
      envelope,
    });
  } catch (err) {
    logger.warn('Failed to build custom cross-platform context', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Build avatar config for prompt builder
  const enabledCategories = toolsToCategories(avatarConfig.tools || []);
  
  // Add voice category if enabled
  if (avatarConfig.voice?.enabled && !enabledCategories.includes('voice')) {
    enabledCategories.push('voice');
  }

  const processorConfig: ProcessorAvatarConfig = {
    avatarId,
    name: avatarConfig.name,
    // AvatarConfig uses 'persona' for description
    persona: avatarConfig.persona,
    enabledCategories,
  };

  // Build runtime context
  const runtimeContext: RuntimeContext = {
    channelId: envelope.conversationId,
    channelType,
    timestamp: new Date(),
    sender: {
      id: envelope.sender.id,
      username: envelope.sender.username,
      displayName: envelope.sender.displayName,
    },
    presenceContext,
    customContext,
  };

  return buildDynamicSystemPrompt(processorConfig, envelope.platform as Platform, runtimeContext);
}

function truncateForPrompt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function formatRelativeTime(timestampMs: number, nowMs: number): string {
  const diffMs = Math.max(0, nowMs - timestampMs);
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

async function buildRecentBotActivityDigest(params: {
  avatarId: string;
  currentChannelId?: string;
  currentPlatform?: Platform;
}): Promise<string | null> {
  const now = Date.now();

  const channels = await presenceService.getAllChannels(params.avatarId);
  if (channels.length === 0) return null;

  const sorted = channels
    .slice()
    .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
    .slice(0, 8);

  const lines: string[] = [];
  for (const ch of sorted) {
    if (
      params.currentChannelId &&
      params.currentPlatform &&
      ch.channelId === params.currentChannelId &&
      ch.platform === params.currentPlatform
    ) {
      continue;
    }

    const state = await stateService.getChannelState(params.avatarId, ch.channelId);
    const recent = state?.recentMessages || [];
    const lastBot = [...recent].reverse().find((m) => m.isBot && Boolean(m.content));
    if (!lastBot) continue;

    // Only include reasonably recent bot outputs to avoid stale noise.
    if (now - lastBot.timestamp > 2 * 60 * 60_000) continue;

    const channelLabel = ch.title || ch.channelId;
    lines.push(
      `- ${ch.platform}/${channelLabel} (${formatRelativeTime(lastBot.timestamp, now)}): ${truncateForPrompt(lastBot.content.replace(/\s+/g, ' ').trim(), 140)}`
    );
    if (lines.length >= 4) break;
  }

  if (lines.length === 0) return null;
  return [
    '## Recent Bot Activity (cross-platform)',
    'This is the bot\'s own recent outbound content across channels/platforms (no user messages).',
    ...lines,
  ].join('\n');
}

async function buildHomeChannelSummaryContext(params: {
  avatarId: string;
  avatarConfig: AvatarConfig;
  avatarSecrets: Record<string, string>;
  envelope: SwarmEnvelope;
}): Promise<string | null> {
  const telegramCfg = params.avatarConfig.platforms?.telegram;
  const homeChannelId = telegramCfg?.homeChannelId;
  if (!homeChannelId) return null;

  const summaryService = createChannelSummaryService(params.avatarSecrets);

  let summary: string | null = null;
  try {
    summary = await summaryService.getOrGenerateSummary(
      params.avatarId,
      homeChannelId,
      'telegram',
      presenceService,
      stateService.getChannelState.bind(stateService)
    );
  } catch (err) {
    logger.warn('Failed to get/generate home channel summary', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!summary) return null;

  const channelDetail = await presenceService.getChannelWithSummary(params.avatarId, homeChannelId, 'telegram');
  const homeLabel = channelDetail?.title
    || (telegramCfg?.homeChannelUsername ? `@${telegramCfg.homeChannelUsername}` : undefined)
    || homeChannelId;

  const isInHomeChannel = params.envelope.platform === 'telegram' && params.envelope.conversationId === homeChannelId;
  const locationNote = isInHomeChannel ? ' (current channel)' : '';

  return [
    '## Home Channel Summary',
    `Home channel (Telegram ${homeLabel}${locationNote}): ${truncateForPrompt(summary, 220)}`,
    '',
    'Safety: When replying publicly (e.g., Twitter), do not quote or attribute private chat; use this only as high-level background context.',
  ].join('\n');
}

async function buildCrossPlatformCustomContext(params: {
  avatarId: string;
  avatarConfig: AvatarConfig;
  avatarSecrets: Record<string, string>;
  envelope: SwarmEnvelope;
}): Promise<string | undefined> {
  const parts: string[] = [];

  try {
    const digest = await buildRecentBotActivityDigest({
      avatarId: params.avatarId,
      currentChannelId: params.envelope.conversationId,
      currentPlatform: params.envelope.platform as Platform,
    });
    if (digest) parts.push(digest);
  } catch (err) {
    logger.warn('Failed to build recent bot activity digest', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const homeSummary = await buildHomeChannelSummaryContext(params);
    if (homeSummary) parts.push(homeSummary);
  } catch (err) {
    logger.warn('Failed to build home channel context', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (parts.length === 0) return undefined;
  return parts.join('\n\n');
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

      case 'generate_voice_message': // Legacy alias - keep for backwards compatibility
      case 'send_voice_message': {
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

      // Handle any tool that returns media (gallery, stickers, etc.)
      default: {
        if (result.media?.url && result.media?.type) {
          // Map media types to valid SendMediaAction types
          const typeMap: Record<string, 'image' | 'video' | 'animation'> = {
            image: 'image',
            video: 'video',
            animation: 'animation',
            sticker: 'image', // stickers are treated as images
            gif: 'animation',
          };
          const mediaType = typeMap[result.media.type];
          if (mediaType) {
            actions.push({
              type: 'send_media',
              mediaType,
              url: result.media.url,
            });
          }
        }
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
  const systemPrompt = await buildSystemPrompt(
    envelope,
    avatarRuntime.avatarConfig,
    avatarRuntime.avatarId,
    avatarRuntime.secrets
  );
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

    // Add history messages with proper user/assistant roles
    // Include sender name for multi-user chat context
    for (const msg of recentHistory) {
      messages.push({
        role: msg.isBot ? 'assistant' : 'user',
        // Only prefix user messages with sender name for group chat context.
        // Bot (assistant) messages should NOT include the name prefix,
        // otherwise the LLM learns to prefix its own responses with its name.
        content: msg.isBot ? msg.content : `[${msg.sender}]: ${msg.content}`,
      });
    }

    logger.info('Added channel history to context', {
      event: 'history_added',
      historyCount: recentHistory.length,
      maxContext,
      totalHistory: channelHistory.length,
      historyMessageIds: recentHistory.map(m => m.messageId).slice(0, 5), // Log first 5 IDs for debugging
    });
  } else {
    logger.info('No channel history available', {
      event: 'no_history',
      channelHistoryProvided: !!channelHistory,
      channelHistoryLength: channelHistory?.length ?? 0,
    });
  }

  // Add current user message with sender attribution for group chat context
  const sender = envelope.sender.displayName || envelope.sender.username || envelope.sender.id;
  const text = envelope.content.text || (() => {
    const mediaTypes = envelope.content.media?.map(m => m.type) || [];
    if (mediaTypes.includes('audio')) return '[voice message received]';
    return '[media received]';
  })();
  messages.push({
    role: 'user',
    content: `[${sender}]: ${text}`,
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
          // Save thinking to avatar's memory (if memory is enabled)
          const memoryAllowed = await isMemoryWriteAllowed(envelope.avatarId);
          if (memoryAllowed) {
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
          } else {
            logger.debug('Memory writes disabled, skipping thinking storage', {
              avatarId: envelope.avatarId,
              thinkingCount: thinkingBlocks.length,
            });
          }
        }
        
        // Strip avatar name prefix if the model accidentally added it
        // (e.g., "[Chamuel 😇]: Hey!" becomes "Hey!")
        cleanFinalContent = stripAvatarNamePrefix(cleanFinalContent, avatarRuntime.avatarConfig.name);
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
      const toolLimit = await checkToolCallLimit(envelope.avatarId, allToolResults.length);
      if (!toolLimit.allowed) {
        logger.warn('Tool call blocked by entitlement limits', {
          event: 'limit_exceeded',
          subsystem: 'entitlements',
          tool: toolCall.name,
          reason: toolLimit.reason,
          limit: toolLimit.limit,
          current: toolLimit.current,
        });

        // Tell the model the tool call failed due to policy and stop executing further tools.
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            error: toolLimit.reason || 'Tool calls are limited by your current plan',
          }),
        });
        break;
      }

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
      // ENTITLEMENT ENFORCEMENT
      // =========================================================
      const usageCheck = await checkAndIncrementMessageUsage(avatarId);
      if (!usageCheck.allowed) {
        logger.warn('Message rejected due to limit', {
          event: 'limit_exceeded',
          subsystem: 'entitlements',
          reason: usageCheck.reason,
          limit: usageCheck.limit,
          current: usageCheck.current,
        });
        // Don't retry - this is a policy rejection, not an error
        continue;
      }

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
