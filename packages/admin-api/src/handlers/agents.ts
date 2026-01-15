/**
 * Agent Management API Handler
 * REST endpoints for creating and managing agents
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { authenticateRequest, requireAdmin } from '../auth/cloudflare-access.js';
import { logger } from '@swarm/core';
import * as agentService from '../services/agents.js';
import * as secretsService from '../services/secrets.js';
import * as logsService from '../services/logs.js';
import * as telegramService from '../services/telegram.js';
import * as agentEventsService from '../services/agent-events.js';
import { recordError, listAgentIssues } from '../services/auto-issues.js';
import { SecretType } from '../types.js';
import { getSessionWithUser } from '../services/wallet-auth.js';

// CORS headers - restricted to configured admin domain
const allowedOrigin = process.env.ALLOWED_ORIGINS?.split(',')[0] || 'http://localhost:5173';
const corsHeaders = {
  'Access-Control-Allow-Origin': allowedOrigin,
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, CF-Access-JWT-Assertion',
  'Access-Control-Allow-Credentials': 'true',
};

// Cookie name for wallet session
const WALLET_SESSION_COOKIE = 'swarm_session';

// Admin wallets that can see all agents (comma-separated list)
const ADMIN_WALLETS = (process.env.ADMIN_WALLETS || '').split(',').filter(Boolean);

/**
 * Check if a wallet address is an admin
 */
function isAdminWallet(walletAddress: string): boolean {
  return ADMIN_WALLETS.includes(walletAddress);
}

/**
 * Extract wallet session token from cookies
 */
function getWalletSessionFromCookie(event: APIGatewayProxyEventV2): string | null {
  const cookies = event.cookies || [];
  for (const cookie of cookies) {
    const [name, value] = cookie.split('=');
    if (name === WALLET_SESSION_COOKIE && value) {
      return value;
    }
  }
  return null;
}

/**
 * Lambda handler for agent management API
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  try {
    // Authenticate
    const session = await authenticateRequest(event);
    if (!requireAdmin(session)) {
      return {
        statusCode: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Admin access required' }),
      };
    }

    const method = event.requestContext.http.method;
    const path = event.rawPath;

    // POST /agents - Create a new agent
    if (method === 'POST' && path === '/agents') {
      const body = JSON.parse(event.body || '{}');
      const { name, description } = body;

      if (!name || typeof name !== 'string') {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Name is required' }),
        };
      }

      const agent = await agentService.createAgent(name, session, description);

      return {
        statusCode: 201,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(agent),
      };
    }

    // GET /agents - List agents (filtered by wallet unless admin)
    if (method === 'GET' && path === '/agents') {
      // Check for wallet session to filter agents by creator
      const sessionToken = getWalletSessionFromCookie(event);
      let agents: Awaited<ReturnType<typeof agentService.listAgents>>;

      if (sessionToken) {
        const walletSession = await getSessionWithUser(sessionToken);
        if (walletSession?.walletAddress) {
          // Check if this wallet is an admin
          if (isAdminWallet(walletSession.walletAddress)) {
            // Admin wallet: show all agents
            agents = await agentService.listAgents();
            logger.info(`[Agents] Admin wallet=${walletSession.walletAddress.slice(0, 8)}... listed all ${agents.length} agents`);
          } else {
            // Regular wallet user: show only their created agents
            agents = await agentService.listAgentsByWallet(walletSession.walletAddress);
            logger.info(`[Agents] Listed ${agents.length} agents for wallet=${walletSession.walletAddress.slice(0, 8)}...`);
          }
        } else {
          // Invalid/expired session - return empty list (they need to re-auth)
          agents = [];
          logger.warn('[Agents] Invalid wallet session, returning empty agent list');
        }
      } else {
        // No wallet session (CF Access / internal test only) - return all agents
        agents = await agentService.listAgents();
        logger.info(`[Agents] Listed all ${agents.length} agents (no wallet session)`);
      }

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(agents),
      };
    }

    // GET /agents/{id} - Get single agent
    const agentIdMatch = path.match(/^\/agents\/([^/]+)$/);
    if (method === 'GET' && agentIdMatch) {
      const agentId = agentIdMatch[1];
      const agent = await agentService.getAgent(agentId);

      if (!agent) {
        return {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Agent not found' }),
        };
      }

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(agent),
      };
    }

    // PUT /agents/{id} - Update agent
    if (method === 'PUT' && agentIdMatch) {
      const agentId = agentIdMatch[1];
      const body = JSON.parse(event.body || '{}');

      const agent = await agentService.updateAgent(agentId, body, session);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(agent),
      };
    }

    // DELETE /agents/{id} - Delete agent
    if (method === 'DELETE' && agentIdMatch) {
      const agentId = agentIdMatch[1];
      await agentService.deleteAgent(agentId, session);

      return {
        statusCode: 204,
        headers: corsHeaders,
      };
    }

    // POST /agents/{id}/secrets - Save a secret for an agent
    const secretsMatch = path.match(/^\/agents\/([^/]+)\/secrets$/);
    if (method === 'POST' && secretsMatch) {
      const agentId = secretsMatch[1];
      const body = JSON.parse(event.body || '{}');
      const { key, value } = body;

      if (typeof key !== 'string' || typeof value !== 'string' || !key || !value) {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'key and value are required' }),
        };
      }

      const secretType = SecretType.safeParse(key);
      if (!secretType.success) {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: `Unsupported secret key: ${key}`,
            allowed: SecretType.options,
          }),
        };
      }

      await secretsService.storeSecret(
        agentId,
        secretType.data,
        'default',
        value,
        session,
        `${key} for agent ${agentId}`
      );

      // Special handling for Telegram bot tokens - register webhook automatically
      if (key === 'telegram_bot_token') {
        logger.setContext({ subsystem: 'telegram', agentId });
        logger.info('Telegram token stored via API', { event: 'telegram_token_stored_via_api' });

        const validation = await telegramService.validateTelegramToken(value);
        if (validation.valid) {
          // Update agent config to enable Telegram
          await agentService.updateAgent(agentId, {
            platforms: {
              telegram: {
                enabled: true,
                botUsername: validation.botInfo?.username
              }
            }
          }, session);

          // Register webhook with Telegram
          const webhookResult = await telegramService.registerTelegramWebhook(value, agentId);
          if (webhookResult.success && webhookResult.secretToken) {
            await secretsService.storeSecret(
              agentId,
              'telegram_webhook_secret',
              'default',
              webhookResult.secretToken,
              session,
              `Telegram webhook secret for ${agentId}`
            );
            logger.info('Telegram webhook registered', {
              event: 'telegram_webhook_registered',
              webhookUrl: webhookResult.webhookUrl,
              botUsername: validation.botInfo?.username,
            });
          } else {
            logger.error('Telegram webhook registration failed', undefined, {
              event: 'telegram_webhook_failed',
              error: webhookResult.message,
            });
          }
        } else {
          logger.warn('Telegram token invalid', {
            event: 'telegram_token_invalid',
            error: validation.error,
          });
        }
      }

      // Special handling for Replicate API key - validate it
      if (key === 'replicate_api_key') {
        logger.setContext({ subsystem: 'media', agentId });
        logger.info('Replicate key stored via API', { event: 'replicate_key_stored_via_api' });

        try {
          const response = await fetch('https://api.replicate.com/v1/account', {
            headers: { 'Authorization': `Bearer ${value}` },
          });
          
          if (response.ok) {
            const account = await response.json() as { username?: string };
            logger.info('Replicate key valid', {
              event: 'replicate_key_valid',
              username: account.username,
            });
          } else {
            logger.warn('Replicate key invalid', {
              event: 'replicate_key_invalid',
              status: response.status,
            });
          }
        } catch (err) {
          logger.warn('Replicate key validation error', {
            event: 'replicate_key_validation_error',
            error: err instanceof Error ? err.message : 'Unknown error',
          });
        }
      }

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, message: `${key} stored securely` }),
      };
    }

    // GET /agents/{id}/secrets - List secrets (not values)
    if (method === 'GET' && secretsMatch) {
      const agentId = secretsMatch[1];
      const secrets = await secretsService.listSecrets(agentId);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(secrets),
      };
    }

    // GET /agents/{id}/logs - Query consolidated logs for an agent
    const logsMatch = path.match(/^\/agents\/([^/]+)\/logs$/);
    if (method === 'GET' && logsMatch) {
      const agentId = logsMatch[1];
      const params = event.queryStringParameters || {};

      const limit = params.limit ? Number.parseInt(params.limit, 10) : undefined;
      const startTimeRaw = params.start ? Number.parseInt(params.start, 10) : undefined;
      const endTimeRaw = params.end ? Number.parseInt(params.end, 10) : undefined;
      const startTime = Number.isFinite(startTimeRaw) ? startTimeRaw : undefined;
      const endTime = Number.isFinite(endTimeRaw) ? endTimeRaw : undefined;

      const result = await logsService.queryAgentLogs(agentId, {
        level: params.level,
        subsystem: params.subsystem || params.component,
        since: params.since,
        limit,
        startTime,
        endTime,
        query: params.query,
      });

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      };
    }

    // GET /agents/{id}/issues - List issues for an agent (from CloudWatch - legacy)
    const issuesMatch = path.match(/^\/agents\/([^/]+)\/issues$/);
    if (method === 'GET' && issuesMatch) {
      const agentId = issuesMatch[1];
      const params = event.queryStringParameters || {};
      const limit = params.limit ? Number.parseInt(params.limit, 10) : undefined;
      const status = params.status as 'open' | 'resolved' | 'all' | undefined;
      const severity = params.severity as 'low' | 'medium' | 'high' | 'critical' | undefined;

      const issues = await listAgentIssues(agentId, { limit, status, severity });

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, issues }),
      };
    }

    // GET /agents/{id}/events - List events (issues + feedback) from DynamoDB
    const eventsMatch = path.match(/^\/agents\/([^/]+)\/events$/);
    if (method === 'GET' && eventsMatch) {
      const agentId = eventsMatch[1];
      const params = event.queryStringParameters || {};
      const limit = params.limit ? Number.parseInt(params.limit, 10) : undefined;
      const type = params.type as 'issue' | 'feedback' | undefined;
      const severity = params.severity as agentEventsService.IssueSeverity | undefined;
      const sentiment = params.sentiment as agentEventsService.FeedbackSentiment | undefined;
      const status = params.status as agentEventsService.IssueStatus | undefined;
      const since = params.since ? Number.parseInt(params.since, 10) : undefined;

      const events = await agentEventsService.listAgentEvents(agentId, {
        type,
        limit,
        since,
        severity,
        sentiment,
        status,
      });

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, events, count: events.length }),
      };
    }

    // GET /agents/{id}/events/counts - Get event summary for dashboard
    const eventCountsMatch = path.match(/^\/agents\/([^/]+)\/events\/counts$/);
    if (method === 'GET' && eventCountsMatch) {
      const agentId = eventCountsMatch[1];
      const counts = await agentEventsService.getAgentEventCounts(agentId);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, ...counts }),
      };
    }

    // PATCH /agents/{id}/events/{eventId} - Update issue status
    const eventUpdateMatch = path.match(/^\/agents\/([^/]+)\/events\/([^/]+)$/);
    if (method === 'PATCH' && eventUpdateMatch) {
      const agentId = eventUpdateMatch[1];
      const eventId = eventUpdateMatch[2];
      const body = JSON.parse(event.body || '{}');
      const { status } = body;

      if (!status || !['open', 'acknowledged', 'resolved', 'wont_fix'].includes(status)) {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Valid status required: open, acknowledged, resolved, wont_fix' }),
        };
      }

      await agentEventsService.updateIssueStatus(agentId, eventId, status, session?.email);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, eventId, status }),
      };
    }

    // Not found
    return {
      statusCode: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Not found' }),
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : undefined;

    logger.setContext({ subsystem: 'agents' });
    logger.error('Agent handler error', error);

    // Record error in auto-issues system
    recordError({
      error: errorMessage,
      stack: errorStack,
      subsystem: 'agents',
      category: 'handler_error',
      requestId: event.requestContext.requestId,
    }).catch(() => {
      // Ignore recording failures
    });

    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Internal server error',
        message: errorMessage,
      }),
    };
  }
}
