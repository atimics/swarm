/**
 * Web Chat Handler
 * Handles REST API requests for web chat interface
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import {
  WebAdapter,
  createStateService,
  createSecretsService,
  createActivityService,
  createLLMService,
  createSolanaService,
  createResponseGenerator,
  logger,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_LLM_TEMPERATURE,
  DEFAULT_LLM_MAX_TOKENS,
  type AvatarConfig,
  type ToolDefinition,
  type WebChatMessage,
  type ResponseAction,
  type SwarmResponse,
} from '@swarm/core';
import { z } from 'zod';

// Environment variables
const STATE_TABLE = process.env.STATE_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const AVATAR_ID = process.env.AVATAR_ID!;
const ADMIN_API_URL = process.env.ADMIN_API_URL; // Optional: for issue reporting
const INTERNAL_TEST_KEY = process.env.INTERNAL_TEST_KEY; // Optional: for issue reporting

// Services
let stateService: ReturnType<typeof createStateService>;
let activityService: ReturnType<typeof createActivityService>;
let secretsService: ReturnType<typeof createSecretsService>;
let webAdapter: WebAdapter;
let secrets: Record<string, string>;
let avatarConfig: AvatarConfig;

/**
 * Report an error to the auto-issues system via admin API
 * Fails silently if admin API is not configured
 */
async function reportIssue(params: {
  error: string;
  subsystem: string;
  category?: string;
  context?: Record<string, unknown>;
}): Promise<void> {
  if (!ADMIN_API_URL || !INTERNAL_TEST_KEY) {
    logger.warn('Issue reporting skipped - ADMIN_API_URL or INTERNAL_TEST_KEY not configured', {
      event: 'issue_report_skipped',
      error: params.error,
      subsystem: params.subsystem,
    });
    return;
  }

  try {
    const response = await fetch(`${ADMIN_API_URL}/issues`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-test-key': INTERNAL_TEST_KEY,
      },
      body: JSON.stringify({
        error: params.error,
        subsystem: params.subsystem,
        category: params.category,
        avatarId: AVATAR_ID,
        context: params.context,
      }),
      signal: AbortSignal.timeout(5000), // 5 second timeout
    });

    if (!response.ok) {
      logger.warn('Failed to report issue to admin API', {
        event: 'issue_report_failed',
        status: response.status,
      });
    }
  } catch (err) {
    // Silently ignore - issue reporting should not affect main flow
    logger.warn('Failed to report issue to admin API', {
      event: 'issue_report_error',
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
}

async function initialize(): Promise<void> {
  if (stateService) return;

  stateService = createStateService(STATE_TABLE);
  activityService = createActivityService(ACTIVITY_TABLE);
  secretsService = createSecretsService();

  avatarConfig = await stateService.getAvatarConfig(AVATAR_ID) || {
    id: AVATAR_ID,
    name: AVATAR_ID,
    version: '1.0.0',
    persona: 'You are a helpful AI assistant.',
    platforms: {
      web: {
        enabled: true,
        corsOrigins: process.env.WEB_CORS_ORIGINS ? process.env.WEB_CORS_ORIGINS.split(',') : [],
        rateLimit: { windowMs: 60000, maxRequests: 20 },
      },
    },
    llm: { provider: DEFAULT_LLM_PROVIDER, model: DEFAULT_LLM_MODEL, temperature: DEFAULT_LLM_TEMPERATURE, maxTokens: DEFAULT_LLM_MAX_TOKENS },
    media: { image: { provider: 'replicate', model: 'black-forest-labs/flux-schnell' } },
    scheduling: {},
    behavior: { responseDelayMs: [0, 0], typingIndicator: false, ignoreBots: true, cooldownMinutes: 0, maxContextMessages: 20 },
    tools: ['send_message'],
    secrets: [],
  };

  secrets = await secretsService.getSecretJson<Record<string, string>>(
    process.env.SECRETS_ARN || `swarm/${AVATAR_ID}/secrets`
  );

  webAdapter = new WebAdapter(avatarConfig);
}

// Simple tool for web chat (direct response)
const webTools: ToolDefinition[] = [
  {
    name: 'send_message',
    description: 'Send a response message',
    parameters: z.object({
      text: z.string().describe('The message text to send'),
    }),
    execute: async () => ({ success: true }),
  },
];

export async function handler(
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> {
  logger.setContext({
    avatarId: AVATAR_ID,
    platform: 'web',
    requestId: context.awsRequestId,
  });

  try {
    await initialize();

    const origin = event.headers.origin || event.headers.Origin;
    const corsHeaders = webAdapter.getCorsHeaders(origin);

    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: '',
      };
    }

    // Verify request
    const body = event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf-8') : Buffer.from('');
    const headers = Object.fromEntries(
      Object.entries(event.headers).map(([k, v]) => [k.toLowerCase(), v || ''])
    );

    const isValid = await webAdapter.verifyRequest(body, headers);
    if (!isValid) {
      return {
        statusCode: 403,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Forbidden' }),
      };
    }

    // Parse message
    const message: WebChatMessage = JSON.parse(body.toString());

    // Token gating check
    if (avatarConfig.platforms.web?.tokenGated?.enabled) {
      if (!message.wallet?.address) {
        return {
          statusCode: 401,
          headers: corsHeaders,
          body: JSON.stringify({ error: 'Wallet connection required' }),
        };
      }

      // Verify token balance
      if (avatarConfig.solana?.enabled) {
        const solanaService = createSolanaService(avatarConfig.solana);
        const hasBalance = await solanaService.verifyTokenHolder(
          message.wallet.address,
          avatarConfig.platforms.web.tokenGated.tokenMint,
          avatarConfig.platforms.web.tokenGated.minBalance
        );

        if (!hasBalance) {
          return {
            statusCode: 403,
            headers: corsHeaders,
            body: JSON.stringify({ 
              error: 'Insufficient token balance',
              required: avatarConfig.platforms.web.tokenGated.minBalance,
            }),
          };
        }
      }
    }

    // Parse into envelope
    const envelope = await webAdapter.parseMessage(message);
    if (!envelope) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Invalid message format' }),
      };
    }

    // Log received message
    await activityService.logMessageReceived(
      AVATAR_ID,
      'web',
      envelope.sender.displayName || 'Web User',
      envelope.content.text || ''
    );

    // Generate response synchronously for web chat with retry logic
    const llmService = createLLMService(avatarConfig.llm, secrets);
    const generator = createResponseGenerator(
      avatarConfig,
      llmService,
      stateService,
      webTools,
      avatarConfig.persona
    );

    const MAX_RETRIES = 2;
    const RETRY_DELAY_MS = 1000;
    let responseText = '';
    let lastResponse: SwarmResponse | null = null;
    
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      lastResponse = await generator.generate(envelope);

      // Extract text response
      const messageAction = lastResponse.actions.find((a: ResponseAction) => a.type === 'send_message');
      responseText = messageAction && 'text' in messageAction ? messageAction.text : '';
      
      if (responseText) {
        break; // Got a valid response, exit retry loop
      }
      
      if (attempt < MAX_RETRIES) {
        logger.warn('Empty LLM response, retrying', {
          event: 'llm_retry',
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
        });
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
    
    // Final fallback if all retries exhausted
    if (!responseText) {
      logger.error('LLM response empty after all retries', {
        event: 'llm_empty_after_retries',
        attempts: MAX_RETRIES + 1,
      });
      
      // Report issue to auto-issues system
      await reportIssue({
        error: 'LLM returned empty response after all retries',
        subsystem: 'llm',
        category: 'llm_empty_response',
        context: {
          attempts: MAX_RETRIES + 1,
          platform: 'web',
          model: avatarConfig.llm.model,
        },
      });
      
      responseText = 'I apologize, but I was unable to generate a response. Please try again.';
    }

    // Update channel state
    await stateService.addMessageToChannel(
      AVATAR_ID,
      envelope.conversationId,
      'web',
      {
        messageId: envelope.messageId,
        sender: envelope.sender.displayName || 'User',
        isBot: false,
        content: envelope.content.text || '',
        timestamp: envelope.timestamp,
      }
    );

    await stateService.addMessageToChannel(
      AVATAR_ID,
      envelope.conversationId,
      'web',
      {
        messageId: `bot_${Date.now()}`,
        sender: avatarConfig.name,
        isBot: true,
        content: responseText,
        timestamp: Date.now(),
      }
    );

    // Log response
    if (lastResponse) {
      await activityService.logResponseSent(AVATAR_ID, 'web', lastResponse.actions);
    }

    // Return response
    const webResponse = webAdapter.createResponse(AVATAR_ID, responseText);

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        ...getSecurityHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(webResponse),
    };

  } catch (error) {
    logger.error('Web chat error', error);

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        ...getSecurityHeaders(),
      },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}

/** Standard security headers applied to all responses */
function getSecurityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  };
}
