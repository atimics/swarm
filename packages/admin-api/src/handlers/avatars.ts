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
import * as discordService from '../services/discord.js';
import * as avatarventsService from '../services/avatar-events.js';
import * as galleryService from '../services/gallery.js';
import * as integrationsService from '../services/integrations.js';
import * as twitterFeedService from '../services/twitter-feed.js';
import * as observabilityService from '../services/observability.js';
import { recordError, listAvatarIssues } from '../services/auto-issues.js';
import { setupTelegramIntegration } from '../services/telegram-setup.js';
import { diagnoseTelegram } from '../services/telegram-diagnostics.js';
import { computeTelegramRepairPlan } from '../services/telegram-repair.js';
import { getKnownTelegramUsers } from '../services/channel-state.js';
import { validateReplicateApiKey } from '../services/replicate.js';
import { SecretType } from '../types.js';
import { resumeChatAfterToolResult } from './chat.js';
import { getSessionWithUser } from '../services/wallet-auth.js';
import { getSessionFromCookie } from '../auth/session-cookie.js';
import { getCorsHeaders } from '../http/cors.js';
import { isAuthError } from '../auth/errors.js';

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

function parseSinceQueryParam(value?: string): number | undefined {
  if (!value) return undefined;
  const relative = parseSinceParam(value);
  if (relative !== undefined) return relative;
  const numeric = Number.parseInt(value, 10);
  return Number.isFinite(numeric) ? numeric : undefined;
}

/**
 * Check if a wallet address is an admin
 */
function isAdminWallet(walletAddress: string): boolean {
  return ADMIN_WALLETS.includes(walletAddress);
}

function jsonResponse(
  corsHeaders: Record<string, string>,
  statusCode: number,
  body: unknown
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function getWalletSessionFromEvent(event: APIGatewayProxyEventV2) {
  const sessionToken = getSessionFromCookie(event);
  if (!sessionToken) return null;
  return getSessionWithUser(sessionToken);
}

async function hydrateAvatarProfileImage<T extends { avatarId: string; profileImage?: { url: string } }>(avatar: T): Promise<T> {
  if (avatar.profileImage?.url) return avatar;
  const inferred = await galleryService.getLatestProfileImageFromGallery(avatar.avatarId);
  if (!inferred) return avatar;

  return {
    ...avatar,
    profileImage: {
      url: inferred.url,
      s3Key: inferred.s3Key,
      updatedAt: inferred.createdAt,
    },
  };
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
    const isAdmin = requireAdmin(session);
    const walletSession = await getWalletSessionFromEvent(event);
    const walletAddress = walletSession?.walletAddress ?? null;
    const effectiveIsAdmin = isAdmin || (walletAddress ? isAdminWallet(walletAddress) : false);

    const method = event.requestContext.http.method;
    const rawPath = event.rawPath;
    // CloudFront (and some gateway setups) route the admin API under `/api/*` but our
    // Lambda handlers historically matched on `/...` paths. Normalize so both work.
    const path = rawPath === '/api'
      ? '/'
      : rawPath.startsWith('/api/')
        ? rawPath.slice('/api'.length)
        : rawPath;

    // GET /system/status - Admin-only system overview
    if (method === 'GET' && path === '/system/status') {
      if (!effectiveIsAdmin) {
        return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
      }
      const params = event.queryStringParameters || {};
      const since = parseSinceQueryParam(params.since);
      const avatarId = params.avatarId;

      const status = await observabilityService.getSystemStatus({ since, avatarId });

      return jsonResponse(corsHeaders, 200, status);
    }

    // GET /integrations/models - Centralized model catalog for configuration UI
    if (method === 'GET' && path === '/integrations/models') {
      const integrationParam = event.queryStringParameters?.integration;
      const allowed = ['replicate', 'openai', 'anthropic', 'openrouter'] as const;

      if (integrationParam && !allowed.includes(integrationParam as (typeof allowed)[number])) {
        return jsonResponse(corsHeaders, 400, {
          error: `Unknown integration: ${integrationParam}`,
        });
      }

      if (integrationParam) {
        const modelsByCapability = integrationsService.getAvailableModelsForIntegration(
          integrationParam as (typeof allowed)[number]
        );
        return jsonResponse(corsHeaders, 200, {
          integration: integrationParam,
          modelsByCapability,
        });
      }

      const integrations = allowed.reduce<Record<string, ReturnType<typeof integrationsService.getAvailableModelsForIntegration>>>(
        (acc, integration) => {
          acc[integration] = integrationsService.getAvailableModelsForIntegration(integration);
          return acc;
        },
        {}
      );

      return jsonResponse(corsHeaders, 200, { integrations });
    }

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

      // Wallet user: use gated creation (non-admin allowed)
      if (walletAddress) {
        const result = await avatarService.createAvatarWithWallet(name, walletAddress, description);
        if (!result.success) {
          const errorMessage = result.error === 'no_gate_slot'
            ? 'No available avatar slots. Hold an Orb NFT to create more avatars.'
            : result.error === 'name_taken'
            ? 'An avatar with this name already exists.'
            : 'Failed to create avatar.';
          return jsonResponse(corsHeaders, result.error === 'no_gate_slot' ? 403 : 400, {
            error: errorMessage,
            gateStatus: result.gateStatus,
          });
        }

        logger.info(`[Avatars] Created avatar=${result.avatar!.avatarId} by wallet=${walletAddress.slice(0, 8)}...`);
        return jsonResponse(corsHeaders, 201, result.avatar);
      }

      // Legacy email-based creation stays admin-only
      if (!effectiveIsAdmin) {
        return jsonResponse(corsHeaders, 403, { error: 'Wallet sign-in required' });
      }

      const avatar = await avatarService.createAvatar(name, session, description);

      return {
        statusCode: 201,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(avatar),
      };
    }

    // GET /avatars - List avatars (filtered by wallet unless admin)
    if (method === 'GET' && path === '/avatars') {
      let avatars: Awaited<ReturnType<typeof avatarService.listAvatars>>;

      if (walletAddress) {
        if (effectiveIsAdmin) {
          avatars = await avatarService.listAvatars();
          logger.info(`[Avatars] Admin wallet=${walletAddress.slice(0, 8)}... listed all ${avatars.length} avatars`);
        } else {
          avatars = await avatarService.listAvatarsByWallet(walletAddress);
          logger.info(`[Avatars] Listed ${avatars.length} avatars for wallet=${walletAddress.slice(0, 8)}...`);
        }
      } else if (effectiveIsAdmin) {
        avatars = await avatarService.listAvatars();
        logger.info(`[Avatars] Listed all ${avatars.length} avatars (no wallet session)`);
      } else {
        return jsonResponse(corsHeaders, 403, { error: 'Authentication required' });
      }

      // Back-compat: older avatars may not have `profileImage` set, but may have
      // a generated profile image in the gallery.
      const hydrated = await Promise.all(avatars.map(hydrateAvatarProfileImage));

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(hydrated),
      };
    }

    // GET /avatars/{id} - Get single avatar
    const avatardMatch = path.match(/^\/avatars\/([^/]+)$/);
    if (method === 'GET' && avatardMatch) {
      const avatarId = avatardMatch[1];
      const avatarRaw = await avatarService.getAvatar(avatarId);
      const avatar = avatarRaw ? await hydrateAvatarProfileImage(avatarRaw) : null;

      if (!avatar) {
        return {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Avatar not found' }),
        };
      }

      if (!effectiveIsAdmin) {
        if (!walletAddress || (avatar.creatorWallet !== walletAddress && avatar.inhabitantWallet !== walletAddress)) {
          return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
        }
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

      if (!effectiveIsAdmin) {
        if (!walletAddress) {
          return jsonResponse(corsHeaders, 403, { error: 'Authentication required' });
        }
        const existing = await avatarService.getAvatar(avatarId);
        if (!existing || (existing.creatorWallet !== walletAddress && existing.inhabitantWallet !== walletAddress)) {
          return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
        }
      }

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

      if (!effectiveIsAdmin) {
        if (!walletAddress) {
          return jsonResponse(corsHeaders, 403, { error: 'Authentication required' });
        }
        const existing = await avatarService.getAvatar(avatarId);
        if (!existing || existing.creatorWallet !== walletAddress) {
          return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
        }
      }

      await avatarService.deleteAvatar(avatarId, session);

      return {
        statusCode: 204,
        headers: corsHeaders,
      };
    }

    // PUT /avatars/{id}/reassign - Admin-only: Reassign avatar ownership
    const reassignMatch = path.match(/^\/avatars\/([^/]+)\/reassign$/);
    if (method === 'PUT' && reassignMatch) {
      const avatarId = reassignMatch[1];

      // Admin-only endpoint
      if (!effectiveIsAdmin) {
        return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
      }

      const body = JSON.parse(event.body || '{}') as {
        creatorWallet?: string;
        inhabitantWallet?: string | null;
      };

      const existing = await avatarService.getAvatar(avatarId);
      if (!existing) {
        return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
      }

      try {
        const result = await avatarService.reassignAvatar(avatarId, body, session);
        logger.info(`[Avatars] Reassigned avatar=${avatarId}`, {
          event: 'avatar_reassigned',
          avatarId,
          oldCreator: existing.creatorWallet?.slice(0, 8),
          newCreator: body.creatorWallet?.slice(0, 8),
          inhabitantCleared: body.inhabitantWallet === null,
        });
        return jsonResponse(corsHeaders, 200, result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to reassign avatar';
        return jsonResponse(corsHeaders, 400, { error: msg });
      }
    }

    // GET /avatars/{id}/integrations - List integration statuses
    const avatarIntegrationsMatch = path.match(/^\/avatars\/([^/]+)\/integrations$/);
    if (method === 'GET' && avatarIntegrationsMatch) {
      const avatarId = avatarIntegrationsMatch[1];

      if (!effectiveIsAdmin) {
        if (!walletAddress) {
          return jsonResponse(corsHeaders, 403, { error: 'Authentication required' });
        }
        const existing = await avatarService.getAvatar(avatarId);
        if (!existing || (existing.creatorWallet !== walletAddress && existing.inhabitantWallet !== walletAddress)) {
          return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
        }
      }

      const statuses = await integrationsService.getAllIntegrationStatuses(avatarId);
      return jsonResponse(corsHeaders, 200, { integrations: statuses });
    }

    // GET /avatars/{id}/telegram/diagnose - Telegram diagnostics (used by Admin UI)
    const telegramDiagnoseMatch = path.match(/^\/avatars\/([^/]+)\/telegram\/diagnose$/);
    if (method === 'GET' && telegramDiagnoseMatch) {
      const avatarId = telegramDiagnoseMatch[1];

      if (!effectiveIsAdmin) {
        if (!walletAddress) {
          return jsonResponse(corsHeaders, 403, { error: 'Authentication required' });
        }
        const existing = await avatarService.getAvatar(avatarId);
        if (!existing || (existing.creatorWallet !== walletAddress && existing.inhabitantWallet !== walletAddress)) {
          return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
        }
      }

      try {
        const diagnosis = await diagnoseTelegram(avatarId);
        return jsonResponse(corsHeaders, 200, diagnosis);
      } catch (err) {
        logger.setContext({ subsystem: 'telegram', avatarId });
        logger.error('Telegram diagnostics failed', { event: 'telegram_diagnostics_failed', error: err });
        return jsonResponse(corsHeaders, 500, { error: 'Failed to run Telegram diagnostics' });
      }
    }

    // POST /avatars/{id}/telegram/repair - Re-register webhook if mismatched
    const telegramRepairMatch = path.match(/^\/avatars\/([^/]+)\/telegram\/repair$/);
    if (method === 'POST' && telegramRepairMatch) {
      const avatarId = telegramRepairMatch[1];
      const body = JSON.parse(event.body || '{}') as {
        dryRun?: boolean;
        force?: boolean;
        includeDisabled?: boolean;
        rotateSecret?: boolean;
        repairOnPendingUpdates?: boolean;
        repairOnLastError?: boolean;
      };

      if (!effectiveIsAdmin) {
        if (!walletAddress) {
          return jsonResponse(corsHeaders, 403, { error: 'Authentication required' });
        }
        const existing = await avatarService.getAvatar(avatarId);
        if (!existing || (existing.creatorWallet !== walletAddress && existing.inhabitantWallet !== walletAddress)) {
          return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
        }
      }

      logger.setContext({ subsystem: 'telegram', avatarId });

      const before = await diagnoseTelegram(avatarId);
      const plan = computeTelegramRepairPlan(before, {
        force: Boolean(body.force),
        includeDisabled: Boolean(body.includeDisabled),
        repairOnPendingUpdates: Boolean(body.repairOnPendingUpdates),
        repairOnLastError: Boolean(body.repairOnLastError),
      });

      if (plan.action === 'skip') {
        return jsonResponse(corsHeaders, 200, {
          avatarId,
          action: 'skipped',
          reason: plan.reason,
          before,
        });
      }

      if (body.dryRun) {
        return jsonResponse(corsHeaders, 200, {
          avatarId,
          action: 'would_repair',
          reason: plan.reason,
          before,
        });
      }

      // Repair without user re-submitting the token.
      const botToken = await secretsService._getSecretValueInternal(avatarId, 'telegram_bot_token', 'default');
      if (!botToken) {
        return jsonResponse(corsHeaders, 400, { error: 'Missing Telegram bot token secret' });
      }

      let webhookSecret = await secretsService._getSecretValueInternal(
        avatarId,
        'telegram_webhook_secret',
        'default'
      );

      const rotateSecret = Boolean(body.rotateSecret);
      const hadSecret = Boolean(webhookSecret);
      if (!webhookSecret || rotateSecret) {
        webhookSecret = telegramService.generateWebhookSecret();
      }

      logger.info('Telegram webhook repair requested', {
        event: 'telegram_webhook_repair_requested',
        force: Boolean(body.force),
        includeDisabled: Boolean(body.includeDisabled),
        rotateSecret,
        hadSecret,
      });

      const result = await telegramService.registerTelegramWebhook(botToken, avatarId, webhookSecret);
      if (!result.success) {
        logger.warn('Telegram webhook repair failed', {
          event: 'telegram_webhook_repair_failed',
          error: result.message,
        });
        return jsonResponse(corsHeaders, 400, { error: result.message || 'Failed to repair Telegram webhook' });
      }

      // Only store the secret if it was missing or explicitly rotated.
      if (!hadSecret || rotateSecret) {
        await secretsService.storeSecret(
          avatarId,
          'telegram_webhook_secret',
          'default',
          webhookSecret,
          session,
          `Telegram webhook secret for ${avatarId}`
        );
      }

      const after = await diagnoseTelegram(avatarId);
      return jsonResponse(corsHeaders, 200, {
        avatarId,
        action: 'repaired',
        reason: plan.reason,
        rotatedSecret: (!hadSecret || rotateSecret) ? true : false,
        before,
        after,
        status: {
          webhookUrl: result.webhookUrl,
          reRegistered: result.reRegistered,
          webhookInfo: result.webhookInfo,
        },
      });
    }

    // GET /avatars/{id}/telegram/known-users - Get users who have interacted with this avatar
    const telegramKnownUsersMatch = path.match(/^\/avatars\/([^/]+)\/telegram\/known-users$/);
    if (method === 'GET' && telegramKnownUsersMatch) {
      const avatarId = telegramKnownUsersMatch[1];

      if (!effectiveIsAdmin) {
        if (!walletAddress) {
          return jsonResponse(corsHeaders, 403, { error: 'Authentication required' });
        }
        const existing = await avatarService.getAvatar(avatarId);
        if (!existing || (existing.creatorWallet !== walletAddress && existing.inhabitantWallet !== walletAddress)) {
          return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
        }
      }

      try {
        const users = await getKnownTelegramUsers(avatarId);
        return jsonResponse(corsHeaders, 200, { users });
      } catch (err) {
        logger.error('Failed to get known Telegram users', { event: 'telegram_known_users_failed', error: err });
        return jsonResponse(corsHeaders, 500, { error: 'Failed to get known Telegram users' });
      }
    }

    // POST /avatars/{id}/telegram/resolve-group - Resolve @groupname to chat ID
    const telegramResolveGroupMatch = path.match(/^\/avatars\/([^/]+)\/telegram\/resolve-group$/);
    if (method === 'POST' && telegramResolveGroupMatch) {
      const avatarId = telegramResolveGroupMatch[1];
      const body = JSON.parse(event.body || '{}') as { username?: string };

      if (!effectiveIsAdmin) {
        if (!walletAddress) {
          return jsonResponse(corsHeaders, 403, { error: 'Authentication required' });
        }
        const existing = await avatarService.getAvatar(avatarId);
        if (!existing || (existing.creatorWallet !== walletAddress && existing.inhabitantWallet !== walletAddress)) {
          return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
        }
      }

      if (!body.username || typeof body.username !== 'string') {
        return jsonResponse(corsHeaders, 400, { error: 'username is required' });
      }

      // Get bot token to make the API call
      const botToken = await secretsService._getSecretValueInternal(avatarId, 'telegram_bot_token', 'default');
      if (!botToken) {
        return jsonResponse(corsHeaders, 400, { error: 'Telegram bot token not configured' });
      }

      try {
        const result = await telegramService.resolveGroupUsername(botToken, body.username);
        if (!result) {
          return jsonResponse(corsHeaders, 404, {
            error: 'Group not found or bot does not have access. Make sure the bot is a member of the group.',
          });
        }
        return jsonResponse(corsHeaders, 200, result);
      } catch (err) {
        logger.error('Failed to resolve Telegram group', { event: 'telegram_resolve_group_failed', error: err });
        return jsonResponse(corsHeaders, 500, { error: 'Failed to resolve group' });
      }
    }

    // POST /avatars/{id}/secrets - Save a secret for an avatar
    const secretsMatch = path.match(/^\/avatars\/([^/]+)\/secrets$/);
    if (method === 'POST' && secretsMatch) {
      const avatarId = secretsMatch[1];
      const body = JSON.parse(event.body || '{}');
      const { key, type, value } = body as { key?: string; type?: string; value?: string };
      const rawKey = key || type;
      let telegramStatus: {
        webhookUrl?: string;
        webhookInfo?: { url?: string; pending_update_count?: number };
        reRegistered?: boolean;
      } | null = null;

      const normalizedKey = typeof rawKey === 'string'
        ? rawKey.trim().toLowerCase()
        : rawKey;

      if (!effectiveIsAdmin) {
        if (!walletAddress) {
          return jsonResponse(corsHeaders, 403, { error: 'Authentication required' });
        }
        const existing = await avatarService.getAvatar(avatarId);
        if (!existing || (existing.creatorWallet !== walletAddress && existing.inhabitantWallet !== walletAddress)) {
          return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
        }
      }

      if (typeof normalizedKey !== 'string' || typeof value !== 'string' || !normalizedKey || !value) {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'key and value are required' }),
        };
      }

      const secretType = SecretType.safeParse(normalizedKey);
      if (!secretType.success) {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: `Unsupported secret key: ${normalizedKey}`,
            allowed: SecretType.options,
          }),
        };
      }

      if (normalizedKey === 'telegram_bot_token') {
        logger.setContext({ subsystem: 'telegram', avatarId });
        logger.info('Telegram token setup requested via API', { event: 'telegram_token_setup_via_api' });

        const setupResult = await setupTelegramIntegration({
          avatarId,
          token: value,
          session,
          deps: {
            validateTelegramToken: telegramService.validateTelegramToken,
            registerTelegramWebhook: telegramService.registerTelegramWebhook,
            generateWebhookSecret: telegramService.generateWebhookSecret,
            updateAvatar: avatarService.updateAvatar,
            storeSecret: secretsService.storeSecret,
          },
        });

        if (!setupResult.success) {
          logger.warn('Telegram token setup failed', {
            event: 'telegram_token_setup_failed',
            error: setupResult.error,
          });
          return jsonResponse(corsHeaders, 400, { error: setupResult.error || 'Failed to configure Telegram' });
        }

        telegramStatus = setupResult.status
          ? {
              webhookUrl: setupResult.status.webhookUrl,
              webhookInfo: setupResult.status.webhookInfo,
              reRegistered: setupResult.status.reRegistered,
            }
          : null;
      } else {
        if (normalizedKey === 'replicate_api_key') {
          logger.setContext({ subsystem: 'media', avatarId });
          logger.info('Replicate key validation requested via API', { event: 'replicate_key_validate_via_api' });

          const validation = await validateReplicateApiKey(value);
          if (!validation.valid) {
            return jsonResponse(corsHeaders, 400, { error: validation.error || 'Replicate key invalid' });
          }
        }

        await secretsService.storeSecret(
          avatarId,
          secretType.data,
          'default',
          value,
          session,
          `${normalizedKey} for avatar ${avatarId}`
        );
      }

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          message: `${normalizedKey} stored securely`,
          telegramStatus: telegramStatus || undefined,
        }),
      };
    }

    // POST /avatars/{id}/validate-token - Validate integration tokens
    const validateTokenMatch = path.match(/^\/avatars\/([^/]+)\/validate-token$/);
    if (method === 'POST' && validateTokenMatch) {
      const avatarId = validateTokenMatch[1];
      const body = JSON.parse(event.body || '{}') as { type?: string; value?: string };

      if (!effectiveIsAdmin) {
        if (!walletAddress) {
          return jsonResponse(corsHeaders, 403, { error: 'Authentication required' });
        }
        const existing = await avatarService.getAvatar(avatarId);
        if (!existing || (existing.creatorWallet !== walletAddress && existing.inhabitantWallet !== walletAddress)) {
          return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
        }
      }

      const normalizedType = typeof body.type === 'string'
        ? body.type.trim().toLowerCase()
        : '';

      if (!normalizedType || typeof body.value !== 'string' || !body.value) {
        return jsonResponse(corsHeaders, 400, { error: 'type and value are required' });
      }

      const secretType = SecretType.safeParse(normalizedType);
      if (!secretType.success) {
        return jsonResponse(corsHeaders, 400, {
          error: `Unsupported secret type: ${normalizedType}`,
          allowed: SecretType.options,
        });
      }

      switch (secretType.data) {
        case 'telegram_bot_token': {
          const validation = await telegramService.validateTelegramToken(body.value);
          return jsonResponse(corsHeaders, 200, validation);
        }
        case 'discord_bot_token': {
          const validation = await discordService.validateBotToken(body.value);
          return jsonResponse(corsHeaders, 200, validation);
        }
        case 'discord_webhook_url': {
          const validation = await discordService.validateWebhookUrl(body.value);
          return jsonResponse(corsHeaders, 200, validation);
        }
        default:
          return jsonResponse(corsHeaders, 400, { error: 'Validation not supported for this secret type' });
      }
    }

    // POST /avatars/{id}/validate-ai-key - Validate AI provider keys server-side (avoids browser CORS)
    const validateAiKeyMatch = path.match(/^\/avatars\/([^/]+)\/validate-ai-key$/);
    if (method === 'POST' && validateAiKeyMatch) {
      const avatarId = validateAiKeyMatch[1];
      const body = JSON.parse(event.body || '{}') as { integration?: string; value?: string };

      if (!effectiveIsAdmin) {
        if (!walletAddress) {
          return jsonResponse(corsHeaders, 403, { error: 'Authentication required' });
        }
        const existing = await avatarService.getAvatar(avatarId);
        if (!existing || (existing.creatorWallet !== walletAddress && existing.inhabitantWallet !== walletAddress)) {
          return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
        }
      }

      const integration = typeof body.integration === 'string' ? body.integration.trim().toLowerCase() : '';
      const value = typeof body.value === 'string' ? body.value.trim() : '';

      if (!integration || !value) {
        return jsonResponse(corsHeaders, 400, { error: 'integration and value are required' });
      }

      if (integration === 'replicate') {
        const validation = await validateReplicateApiKey(value);
        return jsonResponse(corsHeaders, validation.valid ? 200 : 400, validation);
      }

      if (integration === 'openai') {
        try {
          const resp = await fetch('https://api.openai.com/v1/models', {
            headers: { Authorization: `Bearer ${value}` },
          });
          if (resp.status === 401) {
            return jsonResponse(corsHeaders, 400, { valid: false, error: 'Invalid API key. Please check your OpenAI dashboard.' });
          }
          if (!resp.ok) {
            return jsonResponse(corsHeaders, 400, { valid: false, error: `OpenAI API error: ${resp.status} ${resp.statusText}` });
          }
          return jsonResponse(corsHeaders, 200, { valid: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          return jsonResponse(corsHeaders, 400, { valid: false, error: `Could not validate API key: ${msg}` });
        }
      }

      // Best-effort validation for other providers (format-only).
      if (integration === 'anthropic') {
        const looksValid = value.startsWith('sk-ant-') || value.length > 20;
        return jsonResponse(corsHeaders, looksValid ? 200 : 400, {
          valid: looksValid,
          error: looksValid ? undefined : 'API key format looks invalid. Expected something like sk-ant-...'
        });
      }

      if (integration === 'openrouter') {
        const looksValid = value.length > 20;
        return jsonResponse(corsHeaders, looksValid ? 200 : 400, {
          valid: looksValid,
          error: looksValid ? undefined : 'API key format looks invalid.'
        });
      }

      return jsonResponse(corsHeaders, 400, { valid: false, error: `Unsupported integration: ${integration}` });
    }

    // POST /avatars/{id}/tools/{toolCallId} - Submit a tool result and resume chat
    const toolsMatch = path.match(/^\/avatars\/([^/]+)\/tools\/([^/]+)$/);
    if (method === 'POST' && toolsMatch) {
      const avatarId = toolsMatch[1];
      const toolCallId = toolsMatch[2];

      if (!effectiveIsAdmin) {
        if (!walletAddress) {
          return jsonResponse(corsHeaders, 403, { error: 'Authentication required' });
        }
        const existing = await avatarService.getAvatar(avatarId);
        if (!existing || (existing.creatorWallet !== walletAddress && existing.inhabitantWallet !== walletAddress)) {
          return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
        }
      }

      const body = JSON.parse(event.body || '{}') as { result?: unknown };
      if (!('result' in body)) {
        return jsonResponse(corsHeaders, 400, { error: 'result is required' });
      }

      try {
        const resumed = await resumeChatAfterToolResult({
          avatarId,
          toolCallId,
          result: body.result,
          session,
        });

        return jsonResponse(corsHeaders, 200, {
          response: resumed.response,
          history: resumed.history,
          media: resumed.media,
          pendingJobs: resumed.pendingJobs,
          pendingToolCall: resumed.pendingToolCall,
          avatarUpdates: resumed.avatarUpdates,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to resume tool call';
        return jsonResponse(corsHeaders, 400, { error: msg });
      }
    }

    // GET /avatars/{id}/secrets - List secrets (not values)
    if (method === 'GET' && secretsMatch) {
      const avatarId = secretsMatch[1];

      if (!effectiveIsAdmin) {
        if (!walletAddress) {
          return jsonResponse(corsHeaders, 403, { error: 'Authentication required' });
        }
        const existing = await avatarService.getAvatar(avatarId);
        if (!existing || (existing.creatorWallet !== walletAddress && existing.inhabitantWallet !== walletAddress)) {
          return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
        }
      }

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
      if (!effectiveIsAdmin) {
        return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
      }
      const avatarId = logsMatch[1];
      const params = event.queryStringParameters || {};

      const compact = params.compact === 'true';
      const includeLogGroups = compact ? false : params.includeLogGroups !== 'false';

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

      const responseBody = includeLogGroups ? result : { ...result, logGroups: undefined };

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...responseBody, source: 'cloudwatch' }),
      };
    }

    // GET /avatars/{id}/activity - Unified activity timeline (logs + events + jobs)
    const activityMatch = path.match(/^\/avatars\/([^/]+)\/activity$/);
    if (method === 'GET' && activityMatch) {
      const avatarId = activityMatch[1];
      if (!effectiveIsAdmin) {
        if (!walletAddress) {
          return jsonResponse(corsHeaders, 403, { error: 'Authentication required' });
        }
        const existing = await avatarService.getAvatar(avatarId);
        if (!existing || (existing.creatorWallet !== walletAddress && existing.inhabitantWallet !== walletAddress)) {
          return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
        }
      }

      const params = event.queryStringParameters || {};
      const limit = params.limit ? Number.parseInt(params.limit, 10) : undefined;
      const since = parseSinceQueryParam(params.since);

      const activity = await observabilityService.getAvatarActivity(avatarId, { since, limit });

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(activity),
      };
    }

    // GET /avatars/{id}/issues - List issues for an avatar (from CloudWatch - legacy)
    const issuesMatch = path.match(/^\/avatars\/([^/]+)\/issues$/);
    if (method === 'GET' && issuesMatch) {
      if (!effectiveIsAdmin) {
        return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
      }
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
      if (!effectiveIsAdmin) {
        return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
      }
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
      if (!effectiveIsAdmin) {
        return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
      }
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
      if (!effectiveIsAdmin) {
        return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
      }
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

    // =========================================================================
    // TWITTER FEED ROUTES
    // =========================================================================

    // GET /avatars/{id}/twitter/feed - Get Twitter feed data
    const twitterFeedMatch = path.match(/^\/avatars\/([^/]+)\/twitter\/feed$/);
    if (method === 'GET' && twitterFeedMatch) {
      const avatarId = twitterFeedMatch[1];

      // Allow both admin and avatar owners to view feed
      if (!effectiveIsAdmin) {
        if (!walletAddress) {
          return jsonResponse(corsHeaders, 403, { error: 'Authentication required' });
        }
        const existing = await avatarService.getAvatar(avatarId);
        if (!existing || (existing.creatorWallet !== walletAddress && existing.inhabitantWallet !== walletAddress)) {
          return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
        }
      }

      try {
        const feed = await twitterFeedService.getTwitterFeed(avatarId);
        return jsonResponse(corsHeaders, 200, feed);
      } catch (err) {
        logger.error('Failed to get Twitter feed', { event: 'twitter_feed_failed', avatarId, error: err });
        return jsonResponse(corsHeaders, 500, { error: 'Failed to get Twitter feed' });
      }
    }

    // POST /avatars/{id}/twitter/posts/{postId}/approve - Approve a pending post
    const twitterApproveMatch = path.match(/^\/avatars\/([^/]+)\/twitter\/posts\/([^/]+)\/approve$/);
    if (method === 'POST' && twitterApproveMatch) {
      const avatarId = twitterApproveMatch[1];
      const postId = twitterApproveMatch[2];

      if (!effectiveIsAdmin) {
        if (!walletAddress) {
          return jsonResponse(corsHeaders, 403, { error: 'Authentication required' });
        }
        const existing = await avatarService.getAvatar(avatarId);
        if (!existing || (existing.creatorWallet !== walletAddress && existing.inhabitantWallet !== walletAddress)) {
          return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
        }
      }

      const reviewerId = walletAddress || session?.email || 'unknown';

      try {
        const post = await twitterFeedService.approvePost(avatarId, postId, reviewerId);
        if (!post) {
          return jsonResponse(corsHeaders, 404, { error: 'Post not found' });
        }
        return jsonResponse(corsHeaders, 200, post);
      } catch (err) {
        logger.error('Failed to approve post', { event: 'twitter_approve_failed', avatarId, postId, error: err });
        return jsonResponse(corsHeaders, 500, { error: 'Failed to approve post' });
      }
    }

    // POST /avatars/{id}/twitter/posts/{postId}/reject - Reject a pending post
    const twitterRejectMatch = path.match(/^\/avatars\/([^/]+)\/twitter\/posts\/([^/]+)\/reject$/);
    if (method === 'POST' && twitterRejectMatch) {
      const avatarId = twitterRejectMatch[1];
      const postId = twitterRejectMatch[2];
      const body = JSON.parse(event.body || '{}') as { reason?: string };

      if (!effectiveIsAdmin) {
        if (!walletAddress) {
          return jsonResponse(corsHeaders, 403, { error: 'Authentication required' });
        }
        const existing = await avatarService.getAvatar(avatarId);
        if (!existing || (existing.creatorWallet !== walletAddress && existing.inhabitantWallet !== walletAddress)) {
          return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
        }
      }

      const reviewerId = walletAddress || session?.email || 'unknown';
      const reason = body.reason || 'Rejected by reviewer';

      try {
        const post = await twitterFeedService.rejectPost(avatarId, postId, reviewerId, reason);
        if (!post) {
          return jsonResponse(corsHeaders, 404, { error: 'Post not found' });
        }
        return jsonResponse(corsHeaders, 200, post);
      } catch (err) {
        logger.error('Failed to reject post', { event: 'twitter_reject_failed', avatarId, postId, error: err });
        return jsonResponse(corsHeaders, 500, { error: 'Failed to reject post' });
      }
    }

    // DELETE /avatars/{id}/twitter/posts/{postId} - Cancel/delete a pending post
    const twitterDeleteMatch = path.match(/^\/avatars\/([^/]+)\/twitter\/posts\/([^/]+)$/);
    if (method === 'DELETE' && twitterDeleteMatch) {
      const avatarId = twitterDeleteMatch[1];
      const postId = twitterDeleteMatch[2];

      if (!effectiveIsAdmin) {
        if (!walletAddress) {
          return jsonResponse(corsHeaders, 403, { error: 'Authentication required' });
        }
        const existing = await avatarService.getAvatar(avatarId);
        if (!existing || (existing.creatorWallet !== walletAddress && existing.inhabitantWallet !== walletAddress)) {
          return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
        }
      }

      const reviewerId = walletAddress || session?.email || 'unknown';

      try {
        const post = await twitterFeedService.cancelPost(avatarId, postId, reviewerId);
        if (!post) {
          return jsonResponse(corsHeaders, 404, { error: 'Post not found' });
        }
        return jsonResponse(corsHeaders, 204, null);
      } catch (err) {
        logger.error('Failed to cancel post', { event: 'twitter_cancel_failed', avatarId, postId, error: err });
        return jsonResponse(corsHeaders, 500, { error: 'Failed to cancel post' });
      }
    }

    // PUT /avatars/{id}/twitter/moderation - Update moderation mode
    const twitterModerationMatch = path.match(/^\/avatars\/([^/]+)\/twitter\/moderation$/);
    if (method === 'PUT' && twitterModerationMatch) {
      const avatarId = twitterModerationMatch[1];
      const body = JSON.parse(event.body || '{}') as { mode?: 'pre' | 'post' | 'none' };

      if (!effectiveIsAdmin) {
        if (!walletAddress) {
          return jsonResponse(corsHeaders, 403, { error: 'Authentication required' });
        }
        const existing = await avatarService.getAvatar(avatarId);
        if (!existing || (existing.creatorWallet !== walletAddress && existing.inhabitantWallet !== walletAddress)) {
          return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
        }
      }

      if (!body.mode || !['pre', 'post', 'none'].includes(body.mode)) {
        return jsonResponse(corsHeaders, 400, { error: 'Valid mode required: pre, post, or none' });
      }

      try {
        const config = await twitterFeedService.setModerationMode(avatarId, body.mode);
        return jsonResponse(corsHeaders, 200, config);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to update moderation mode';
        logger.error('Failed to update moderation mode', { event: 'twitter_moderation_failed', avatarId, error: err });
        return jsonResponse(corsHeaders, 400, { error: msg });
      }
    }

    // Not found
    return {
      statusCode: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Not found' }),
    };

  } catch (error) {
    if (isAuthError(error)) {
      return {
        statusCode: error.statusCode,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error.message, details: error.details }),
      };
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : undefined;

    if (errorMessage === 'No authentication token provided' || errorMessage === 'Session expired') {
      return jsonResponse(corsHeaders, 401, { error: errorMessage });
    }

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
