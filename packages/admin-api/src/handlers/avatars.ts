/**
 * Avatar Management API Handler
 * REST endpoints for creating and managing avatars
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { authenticateRequest, requireAdmin } from '../auth/cloudflare-access.js';
import { logger } from '@swarm/core';
import * as avatarService from '../services/avatars.js';
import * as secretsService from '../services/secrets.js';
import * as logsService from '../services/logs.js';
import * as avatarogsService from '../services/avatar-logs.js';
import * as telegramService from '../services/telegram.js';
import * as avatarventsService from '../services/avatar-events.js';
import { recordError, listAvatarIssues } from '../services/auto-issues.js';
import { SecretType } from '../types.js';
import { getSessionWithUser } from '../services/wallet-auth.js';
import { getSessionFromCookie } from '../auth/session-cookie.js';
import { getCorsHeaders } from '../http/cors.js';

// Admin wallets that can see all avatars (comma-separated list)
const ADMIN_WALLETS = (process.env.ADMIN_WALLETS || '').split(',').filter(Boolean);

/**
 * Parse a "since" time string like "30m", "1h", "24h" to a timestamp
 */
function parseSinceParam(since: string): number | undefined {
  const match = since.trim().match(/^(\d+)(m|h|d)$/i);
  if (!match) return undefined;
  const value = Number.parseInt(match[1], 10);
  if (!value) return undefined;
  const unit = match[2].toLowerCase();
  const ms = unit === 'm' ? value * 60 * 1000
           : unit === 'h' ? value * 60 * 60 * 1000
           : unit === 'd' ? value * 24 * 60 * 60 * 1000
           : 0;
  return Date.now() - ms;
}

/**
 * Check if a wallet address is an admin
 */
function isAdminWallet(walletAddress: string): boolean {
  return ADMIN_WALLETS.includes(walletAddress);
}

// Cookie parsing is handled by ../auth/session-cookie.ts

/**
 * Lambda handler for avatar management API
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const corsHeaders = getCorsHeaders(event);
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

    // POST /avatars - Create a new avatar
    if (method === 'POST' && path === '/avatars') {
      const body = JSON.parse(event.body || '{}');
      const { name, description } = body;

      if (!name || typeof name !== 'string') {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Name is required' }),
        };
      }

      // Check for wallet session - use wallet-based creation with gating
      const sessionToken = getSessionFromCookie(event);
      if (sessionToken) {
        const walletSession = await getSessionWithUser(sessionToken);
        if (walletSession?.walletAddress) {
          // Wallet user: use gated creation
          const result = await avatarService.createAvatarWithWallet(name, walletSession.walletAddress, description);
          if (!result.success) {
            const errorMessage = result.error === 'no_gate_slot'
              ? 'No available avatar slots. Hold an Orb NFT to create more avatars.'
              : result.error === 'name_taken'
              ? 'An avatar with this name already exists.'
              : 'Failed to create avatar.';
            return {
              statusCode: result.error === 'no_gate_slot' ? 403 : 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              body: JSON.stringify({ error: errorMessage, gateStatus: result.gateStatus }),
            };
          }
          logger.info(`[Avatars] Created avatar=${result.avatar!.avatarId} by wallet=${walletSession.walletAddress.slice(0, 8)}...`);
          return {
            statusCode: 201,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify(result.avatar),
          };
        }
      }

      // Fallback: legacy email-based creation (CF Access admin)
      const avatar = await avatarService.createAvatar(name, session, description);

      return {
        statusCode: 201,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(avatar),
      };
    }

    // GET /avatars - List avatars (filtered by wallet unless admin)
    if (method === 'GET' && path === '/avatars') {
      // Check for wallet session to filter avatars by creator
      const sessionToken = getSessionFromCookie(event);
      let avatars: Awaited<ReturnType<typeof avatarService.listAvatars>>;

      if (sessionToken) {
        const walletSession = await getSessionWithUser(sessionToken);
        if (walletSession?.walletAddress) {
          // Check if this wallet is an admin
          if (isAdminWallet(walletSession.walletAddress)) {
            // Admin wallet: show all avatars
            avatars = await avatarService.listAvatars();
            logger.info(`[Avatars] Admin wallet=${walletSession.walletAddress.slice(0, 8)}... listed all ${avatars.length} avatars`);
          } else {
            // Regular wallet user: show only avatars they created OR inhabit
            avatars = await avatarService.listAvatarsByWallet(walletSession.walletAddress);
            logger.info(`[Avatars] Listed ${avatars.length} avatars for wallet=${walletSession.walletAddress.slice(0, 8)}...`);
          }
        } else {
          // Invalid/expired session - return empty list (they need to re-auth)
          avatars = [];
          logger.warn(`[Avatars] Invalid wallet session (token present but session not found), returning empty list`);
        }
      } else {
        // No wallet session (CF Access / internal test only) - return all avatars
        avatars = await avatarService.listAvatars();
        logger.info(`[Avatars] Listed all ${avatars.length} avatars (no wallet session)`);
      }

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(avatars),
      };
    }

    // GET /avatars/{id} - Get single avatar
    const avatardMatch = path.match(/^\/avatars\/([^/]+)$/);
    if (method === 'GET' && avatardMatch) {
      const avatarId = avatardMatch[1];
      const avatar = await avatarService.getAvatar(avatarId);

      if (!avatar) {
        return {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Avatar not found' }),
        };
      }

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(avatar),
      };
    }

    // PUT /avatars/{id} - Update avatar
    if (method === 'PUT' && avatardMatch) {
      const avatarId = avatardMatch[1];
      const body = JSON.parse(event.body || '{}');

      const avatar = await avatarService.updateAvatar(avatarId, body, session);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(avatar),
      };
    }

    // DELETE /avatars/{id} - Delete avatar
    if (method === 'DELETE' && avatardMatch) {
      const avatarId = avatardMatch[1];
      await avatarService.deleteAvatar(avatarId, session);

      return {
        statusCode: 204,
        headers: corsHeaders,
      };
    }

    // POST /avatars/{id}/secrets - Save a secret for an avatar
    const secretsMatch = path.match(/^\/avatars\/([^/]+)\/secrets$/);
    if (method === 'POST' && secretsMatch) {
      const avatarId = secretsMatch[1];
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
        avatarId,
        secretType.data,
        'default',
        value,
        session,
        `${key} for avatar ${avatarId}`
      );

      // Special handling for Telegram bot tokens - register webhook automatically
      if (key === 'telegram_bot_token') {
        logger.setContext({ subsystem: 'telegram', avatarId });
        logger.info('Telegram token stored via API', { event: 'telegram_token_stored_via_api' });

        const validation = await telegramService.validateTelegramToken(value);
        if (validation.valid) {
          // Update avatar config to enable Telegram
          await avatarService.updateAvatar(avatarId, {
            platforms: {
              telegram: {
                enabled: true,
                botUsername: validation.botInfo?.username
              }
            }
          }, session);

          // Register webhook with Telegram
          const webhookResult = await telegramService.registerTelegramWebhook(value, avatarId);
          if (webhookResult.success && webhookResult.secretToken) {
            await secretsService.storeSecret(
              avatarId,
              'telegram_webhook_secret',
              'default',
              webhookResult.secretToken,
              session,
              `Telegram webhook secret for ${avatarId}`
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
        logger.setContext({ subsystem: 'media', avatarId });
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

    // GET /avatars/{id}/secrets - List secrets (not values)
    if (method === 'GET' && secretsMatch) {
      const avatarId = secretsMatch[1];
      const secrets = await secretsService.listSecrets(avatarId);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(secrets),
      };
    }

    // GET /avatars/{id}/logs - Query consolidated logs for an avatar (CloudWatch - slow)
    const logsMatch = path.match(/^\/avatars\/([^/]+)\/logs$/);
    if (method === 'GET' && logsMatch) {
      const avatarId = logsMatch[1];
      const params = event.queryStringParameters || {};

      // Check if fast=true param is set, use DynamoDB instead of CloudWatch
      if (params.fast === 'true') {
        const limit = params.limit ? Number.parseInt(params.limit, 10) : undefined;
        const since = params.since ? parseSinceParam(params.since) : undefined;
        const result = await avatarogsService.listAvatarLogs(avatarId, {
          level: params.level?.toUpperCase() as avatarogsService.LogLevel | undefined,
          subsystem: params.subsystem || params.component,
          since,
          limit,
          query: params.query,
        });

        return {
          statusCode: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            avatarId,
            logs: result.logs,
            hasMore: result.hasMore,
            source: 'dynamodb',
          }),
        };
      }

      const limit = params.limit ? Number.parseInt(params.limit, 10) : undefined;
      const startTimeRaw = params.start ? Number.parseInt(params.start, 10) : undefined;
      const endTimeRaw = params.end ? Number.parseInt(params.end, 10) : undefined;
      const startTime = Number.isFinite(startTimeRaw) ? startTimeRaw : undefined;
      const endTime = Number.isFinite(endTimeRaw) ? endTimeRaw : undefined;

      const result = await logsService.queryAvatarLogs(avatarId, {
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
        body: JSON.stringify({ ...result, source: 'cloudwatch' }),
      };
    }

    // GET /avatars/{id}/issues - List issues for an avatar (from CloudWatch - legacy)
    const issuesMatch = path.match(/^\/avatars\/([^/]+)\/issues$/);
    if (method === 'GET' && issuesMatch) {
      const avatarId = issuesMatch[1];
      const params = event.queryStringParameters || {};
      const limit = params.limit ? Number.parseInt(params.limit, 10) : undefined;
      const status = params.status as 'open' | 'resolved' | 'all' | undefined;
      const severity = params.severity as 'low' | 'medium' | 'high' | 'critical' | undefined;

      const issues = await listAvatarIssues(avatarId, { limit, status, severity });

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatarId, issues }),
      };
    }

    // GET /avatars/{id}/events - List events (issues + feedback) from DynamoDB
    const eventsMatch = path.match(/^\/avatars\/([^/]+)\/events$/);
    if (method === 'GET' && eventsMatch) {
      const avatarId = eventsMatch[1];
      const params = event.queryStringParameters || {};
      const limit = params.limit ? Number.parseInt(params.limit, 10) : undefined;
      const type = params.type as 'issue' | 'feedback' | undefined;
      const severity = params.severity as avatarventsService.IssueSeverity | undefined;
      const sentiment = params.sentiment as avatarventsService.FeedbackSentiment | undefined;
      const status = params.status as avatarventsService.IssueStatus | undefined;
      const since = params.since ? Number.parseInt(params.since, 10) : undefined;

      const events = await avatarventsService.listAvatarEvents(avatarId, {
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
        body: JSON.stringify({ avatarId, events, count: events.length }),
      };
    }

    // GET /avatars/{id}/events/counts - Get event summary for dashboard
    const eventCountsMatch = path.match(/^\/avatars\/([^/]+)\/events\/counts$/);
    if (method === 'GET' && eventCountsMatch) {
      const avatarId = eventCountsMatch[1];
      const counts = await avatarventsService.getAvatarEventCounts(avatarId);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatarId, ...counts }),
      };
    }

    // PATCH /avatars/{id}/events/{eventId} - Update issue status
    const eventUpdateMatch = path.match(/^\/avatars\/([^/]+)\/events\/([^/]+)$/);
    if (method === 'PATCH' && eventUpdateMatch) {
      const avatarId = eventUpdateMatch[1];
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

      await avatarventsService.updateIssueStatus(avatarId, eventId, status, session?.email);

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

    logger.setContext({ subsystem: 'avatars' });
    logger.error('Avatar handler error', error);

    // Record error in auto-issues system
    recordError({
      error: errorMessage,
      stack: errorStack,
      subsystem: 'avatars',
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
