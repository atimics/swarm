/**
 * Avatar Management API Handler Tests
 *
 * Tests CRUD routes, authentication/authorization gates, error responses (404, 403, 400),
 * path normalization, and entitlement/activation flows.
 *
 * All external dependencies (DynamoDB-backed services, auth, secrets) are mocked.
 *
 * @see packages/admin-api/src/handlers/avatars.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { Mock } from 'vitest';

// Bun's vitest-compat layer doesn't support mocked(). Use a cast helper.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mocked = <T extends (...args: any[]) => any>(fn: T) => fn as unknown as Mock;

// ---------------------------------------------------------------------------
// Mock all imported service modules BEFORE importing the handler.
// vi.mock hoists above imports automatically in vitest.
// ---------------------------------------------------------------------------

vi.mock('../auth/cloudflare-access.js', () => ({
  authenticateRequest: vi.fn(),
  requireAdmin: vi.fn(),
}));

vi.mock('../services/wallet-auth.js', () => ({
  getSessionWithUser: vi.fn(),
}));

vi.mock('../auth/session-cookie.js', () => ({
  getSessionFromCookie: vi.fn(),
}));

vi.mock('../http/cors.js', () => ({
  getCorsHeaders: vi.fn(() => ({
    'Access-Control-Allow-Origin': '*',
  })),
}));

vi.mock('../auth/errors.js', () => {
  class AuthError extends Error {
    readonly statusCode: number;
    readonly details?: unknown;
    constructor(message: string, statusCode: number, details?: unknown) {
      super(message);
      this.name = 'AuthError';
      this.statusCode = statusCode;
      this.details = details;
    }
  }
  return {
    AuthError,
    isAuthError: (e: unknown): e is AuthError => e instanceof AuthError,
  };
});

vi.mock('../services/avatars.js', () => ({
  createAvatar: vi.fn(),
  createAvatarWithWallet: vi.fn(),
  listAvatars: vi.fn(),
  listAvatarsByWallet: vi.fn(),
  getAvatar: vi.fn(),
  updateAvatar: vi.fn(),
  deleteAvatar: vi.fn(),
  activateAvatar: vi.fn(),
  deactivateAvatar: vi.fn(),
  reassignAvatar: vi.fn(),
}));

vi.mock('../services/secrets.js', () => ({
  storeSecret: vi.fn(),
  listSecrets: vi.fn(),
  _getSecretValueInternal: vi.fn(),
}));

vi.mock('../services/logs.js', () => ({
  queryAvatarLogs: vi.fn(),
}));

vi.mock('../services/avatar-logs.js', () => ({
  listAvatarLogs: vi.fn(),
}));

vi.mock('../services/telegram.js', () => ({
  registerTelegramWebhook: vi.fn(),
  validateTelegramToken: vi.fn(),
  generateWebhookSecret: vi.fn(),
  resolveGroupUsername: vi.fn(),
}));

vi.mock('../services/discord.js', () => ({
  validateBotToken: vi.fn(),
  validateWebhookUrl: vi.fn(),
}));

vi.mock('../services/avatar-events.js', () => ({
  listAvatarEvents: vi.fn(),
  getAvatarEventCounts: vi.fn(),
  updateIssueStatus: vi.fn(),
}));

vi.mock('../services/gallery.js', () => ({
  getLatestProfileImageFromGallery: vi.fn(),
}));

vi.mock('../services/integrations.js', () => ({
  getAvailableModelsForIntegration: vi.fn(() => ({})),
  getAllIntegrationStatuses: vi.fn(),
}));

vi.mock('../services/twitter-feed.js', () => ({
  getTwitterFeed: vi.fn(),
  approvePost: vi.fn(),
  rejectPost: vi.fn(),
  cancelPost: vi.fn(),
  setModerationMode: vi.fn(),
}));

vi.mock('../services/observability.js', () => ({
  getSystemStatus: vi.fn(),
  getAvatarActivity: vi.fn(),
}));

vi.mock('../services/energy.js', () => ({
  getEnergyStatus: vi.fn(() => Promise.resolve({
    current: 100,
    max: 100,
    refillPerHour: 10,
    nextRefillIn: 0,
  })),
  getEnergyBankBalance: vi.fn(() => Promise.resolve({ credits: 0 })),
  getEnergyHistory: vi.fn(),
  setEnergy: vi.fn(),
  addEnergy: vi.fn(),
  ENERGY_COSTS: { message: 1, image: 5 },
}));

vi.mock('../services/energy-burn.js', () => ({
  burnDepositedTokensForEnergy: vi.fn(),
}));

vi.mock('../services/burn-stats.js', () => ({
  getBurnStats: vi.fn(() => Promise.resolve({
    totalBurned: 0,
    tier: 0,
    tierName: 'none',
    maxEnergy: 100,
    regenPerHour: 10,
    lastVerifiedAt: Date.now(),
  })),
}));

vi.mock('../services/auto-issues.js', () => ({
  recordError: vi.fn(() => Promise.resolve()),
  listAvatarIssues: vi.fn(),
}));

vi.mock('../services/telegram-setup.js', () => ({
  setupTelegramIntegration: vi.fn(),
}));

vi.mock('../services/telegram-diagnostics.js', () => ({
  diagnoseTelegram: vi.fn(),
}));

vi.mock('../services/telegram-repair.js', () => ({
  computeTelegramRepairPlan: vi.fn(),
}));

vi.mock('../services/channel-state.js', () => ({
  getKnownTelegramUsers: vi.fn(),
}));

vi.mock('../services/replicate.js', () => ({
  validateReplicateApiKey: vi.fn(),
}));

vi.mock('../services/orb-slots.js', () => ({
  slotOrbToAvatar: vi.fn(),
  unslotOrbFromAvatar: vi.fn(),
}));

vi.mock('../services/entitlements.js', () => ({
  getEntitlement: vi.fn(),
  setEntitlement: vi.fn(),
}));

vi.mock('../services/runtime-limits.js', () => ({
  getEffectiveLimitsForAvatar: vi.fn(() => ({
    plan: 'free',
    limits: {},
    source: 'default',
    entitlementStatus: 'active',
  })),
  toRuntimeLimits: vi.fn(() => ({})),
  syncRuntimeLimitsToState: vi.fn(),
}));

vi.mock('./chat.js', () => ({
  resumeChatAfterToolResult: vi.fn(),
}));

vi.mock('@swarm/core', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    setContext: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Now import the handler and mocked modules
// ---------------------------------------------------------------------------
import { handler } from './avatars.js';
import * as auth from '../auth/cloudflare-access.js';
import * as sessionCookie from '../auth/session-cookie.js';
import * as walletAuth from '../services/wallet-auth.js';
import * as avatarService from '../services/avatars.js';
import * as secretsService from '../services/secrets.js';
import * as galleryService from '../services/gallery.js';
import * as integrationsService from '../services/integrations.js';
import * as entitlementsService from '../services/entitlements.js';
import * as observabilityService from '../services/observability.js';
import * as energyService from '../services/energy.js';
import * as orbSlotsService from '../services/orb-slots.js';
import * as avatarEventsService from '../services/avatar-events.js';
import * as chatHandler from './chat.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const DEFAULT_SESSION = {
  email: 'admin@test.com',
  userId: 'user-1',
  isAdmin: true,
  accessToken: 'tok',
};

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> & {
  method?: string;
  path?: string;
  body?: string;
  queryStringParameters?: Record<string, string>;
} = {}): APIGatewayProxyEventV2 {
  const method = overrides.method || 'GET';
  const path = overrides.path || '/avatars';
  return {
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: { origin: 'https://test.com' },
    queryStringParameters: overrides.queryStringParameters || undefined,
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.test.com',
      domainPrefix: 'api',
      http: {
        method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: '$default',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: Date.now(),
    },
    isBase64Encoded: false,
    body: overrides.body || undefined,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

function parseBody(result: { body?: string }) {
  return result.body ? JSON.parse(result.body) : undefined;
}

function setupAdminAuth() {
  mocked(auth.authenticateRequest).mockResolvedValue(DEFAULT_SESSION);
  mocked(auth.requireAdmin).mockReturnValue(true);
  mocked(sessionCookie.getSessionFromCookie).mockReturnValue(null);
  mocked(walletAuth.getSessionWithUser).mockResolvedValue(null);
}

function setupWalletAuth(walletAddress: string, opts: { isAdmin?: boolean } = {}) {
  const session = { ...DEFAULT_SESSION, isAdmin: opts.isAdmin ?? false };
  mocked(auth.authenticateRequest).mockResolvedValue(session);
  mocked(auth.requireAdmin).mockReturnValue(opts.isAdmin ?? false);
  mocked(sessionCookie.getSessionFromCookie).mockReturnValue('session-tok');
  mocked(walletAuth.getSessionWithUser).mockResolvedValue({
    walletAddress,
    sessionToken: 'session-tok',
    accountId: 'acc-1',
    isOrbHolder: false,
    user: {} as any,
  });
}

function setupNonAdminNoWallet() {
  mocked(auth.authenticateRequest).mockResolvedValue({ ...DEFAULT_SESSION, isAdmin: false });
  mocked(auth.requireAdmin).mockReturnValue(false);
  mocked(sessionCookie.getSessionFromCookie).mockReturnValue(null);
  mocked(walletAuth.getSessionWithUser).mockResolvedValue(null);
}

const MOCK_AVATAR = {
  avatarId: 'avatar-1',
  name: 'Test Avatar',
  status: 'draft',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  createdBy: 'admin@test.com',
  creatorWallet: 'wallet-1',
  inhabitantWallet: null,
  platforms: {},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mocked(galleryService.getLatestProfileImageFromGallery).mockResolvedValue(null);
});

// =========================================================================
// OPTIONS preflight
// =========================================================================
describe('OPTIONS preflight', () => {
  it('returns 204 with CORS headers', async () => {
    const event = makeEvent({ method: 'OPTIONS', path: '/avatars' });
    const result = await handler(event);
    expect(result.statusCode).toBe(204);
  });
});

// =========================================================================
// Path normalization (/api prefix stripping)
// =========================================================================
describe('path normalization', () => {
  it('strips /api prefix from rawPath', async () => {
    setupAdminAuth();
    mocked(avatarService.listAvatars).mockResolvedValue([]);

    const event = makeEvent({ method: 'GET', path: '/api/avatars' });
    // Override rawPath directly
    event.rawPath = '/api/avatars';
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
  });

  it('treats /api as root', async () => {
    setupAdminAuth();
    const event = makeEvent({ method: 'GET', path: '/api' });
    event.rawPath = '/api';
    const result = await handler(event);
    // Root path doesn't match any route -> 404
    expect(result.statusCode).toBe(404);
  });
});

// =========================================================================
// POST /avatars - Create Avatar
// =========================================================================
describe('POST /avatars', () => {
  it('creates avatar for admin user', async () => {
    setupAdminAuth();
    const createdAvatar = { ...MOCK_AVATAR, avatarId: 'new-1' };
    mocked(avatarService.createAvatar).mockResolvedValue(createdAvatar as any);

    const event = makeEvent({
      method: 'POST',
      path: '/avatars',
      body: JSON.stringify({ name: 'New Avatar', description: 'A test' }),
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(201);
    expect(parseBody(result).avatarId).toBe('new-1');
  });

  it('returns 400 when name is missing', async () => {
    setupAdminAuth();
    const event = makeEvent({
      method: 'POST',
      path: '/avatars',
      body: JSON.stringify({}),
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(parseBody(result).error).toContain('Name is required');
  });

  it('returns 400 when name is not a string', async () => {
    setupAdminAuth();
    const event = makeEvent({
      method: 'POST',
      path: '/avatars',
      body: JSON.stringify({ name: 123 }),
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });

  it('creates avatar via wallet (gated creation)', async () => {
    setupWalletAuth('wallet-1');
    mocked(avatarService.createAvatarWithWallet).mockResolvedValue({
      success: true,
      avatar: { ...MOCK_AVATAR, avatarId: 'wallet-new' } as any,
    });

    const event = makeEvent({
      method: 'POST',
      path: '/avatars',
      body: JSON.stringify({ name: 'Wallet Avatar' }),
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(201);
    expect(parseBody(result).avatarId).toBe('wallet-new');
  });

  it('returns 403 when wallet has no gate slot', async () => {
    setupWalletAuth('wallet-1');
    mocked(avatarService.createAvatarWithWallet).mockResolvedValue({
      success: false,
      error: 'no_gate_slot',
      gateStatus: { nftsHeld: 0, avatarsCreated: 1, availableSlots: 0 },
    } as any);

    const event = makeEvent({
      method: 'POST',
      path: '/avatars',
      body: JSON.stringify({ name: 'Gated Avatar' }),
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(403);
    expect(parseBody(result).error).toContain('Orb NFT');
  });

  it('returns 400 when name is taken (wallet creation)', async () => {
    setupWalletAuth('wallet-1');
    mocked(avatarService.createAvatarWithWallet).mockResolvedValue({
      success: false,
      error: 'name_taken',
    } as any);

    const event = makeEvent({
      method: 'POST',
      path: '/avatars',
      body: JSON.stringify({ name: 'Taken' }),
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(parseBody(result).error).toContain('already exists');
  });

  it('returns 403 for non-admin without wallet', async () => {
    setupNonAdminNoWallet();
    const event = makeEvent({
      method: 'POST',
      path: '/avatars',
      body: JSON.stringify({ name: 'Not Allowed' }),
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(403);
    expect(parseBody(result).error).toContain('Wallet sign-in required');
  });
});

// =========================================================================
// GET /avatars - List Avatars
// =========================================================================
describe('GET /avatars', () => {
  it('returns all avatars for admin', async () => {
    setupAdminAuth();
    const avatars = [MOCK_AVATAR];
    mocked(avatarService.listAvatars).mockResolvedValue(avatars as any);

    const event = makeEvent({ method: 'GET', path: '/avatars' });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    const body = parseBody(result);
    expect(body).toHaveLength(1);
    expect(body[0].avatarId).toBe('avatar-1');
  });

  it('returns filtered avatars for wallet user', async () => {
    setupWalletAuth('wallet-1');
    mocked(avatarService.listAvatarsByWallet).mockResolvedValue([MOCK_AVATAR] as any);

    const event = makeEvent({ method: 'GET', path: '/avatars' });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(parseBody(result)).toHaveLength(1);
    expect(mocked(avatarService.listAvatarsByWallet)).toHaveBeenCalledWith('wallet-1');
  });

  it('returns all avatars for admin wallet user', async () => {
    setupWalletAuth('wallet-1', { isAdmin: true });
    mocked(avatarService.listAvatars).mockResolvedValue([MOCK_AVATAR] as any);

    const event = makeEvent({ method: 'GET', path: '/avatars' });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(mocked(avatarService.listAvatars)).toHaveBeenCalled();
  });

  it('returns 403 for non-admin without wallet', async () => {
    setupNonAdminNoWallet();
    const event = makeEvent({ method: 'GET', path: '/avatars' });
    const result = await handler(event);
    expect(result.statusCode).toBe(403);
    expect(parseBody(result).error).toContain('Authentication required');
  });

  it('hydrates profile images from gallery', async () => {
    setupAdminAuth();
    const avatarNoImage = { ...MOCK_AVATAR, profileImage: undefined };
    mocked(avatarService.listAvatars).mockResolvedValue([avatarNoImage] as any);
    mocked(galleryService.getLatestProfileImageFromGallery).mockResolvedValue({
      url: 'https://cdn.example.com/img.png',
      s3Key: 'images/img.png',
      createdAt: Date.now(),
    } as any);

    const event = makeEvent({ method: 'GET', path: '/avatars' });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    const body = parseBody(result);
    expect(body[0].profileImage.url).toBe('https://cdn.example.com/img.png');
  });
});

// =========================================================================
// GET /avatars/{id} - Get Single Avatar
// =========================================================================
describe('GET /avatars/{id}', () => {
  it('returns avatar for admin', async () => {
    setupAdminAuth();
    mocked(avatarService.getAvatar).mockResolvedValue(MOCK_AVATAR as any);

    const event = makeEvent({ method: 'GET', path: '/avatars/avatar-1' });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(parseBody(result).avatarId).toBe('avatar-1');
  });

  it('returns 404 for non-existent avatar', async () => {
    setupAdminAuth();
    mocked(avatarService.getAvatar).mockResolvedValue(null);

    const event = makeEvent({ method: 'GET', path: '/avatars/no-such' });
    const result = await handler(event);
    expect(result.statusCode).toBe(404);
    expect(parseBody(result).error).toContain('Avatar not found');
  });

  it('returns 404 for non-owner wallet user', async () => {
    setupWalletAuth('other-wallet');
    mocked(avatarService.getAvatar).mockResolvedValue({
      ...MOCK_AVATAR,
      creatorWallet: 'wallet-1',
      inhabitantWallet: null,
    } as any);

    const event = makeEvent({ method: 'GET', path: '/avatars/avatar-1' });
    const result = await handler(event);
    expect(result.statusCode).toBe(404);
  });

  it('returns avatar for creator wallet', async () => {
    setupWalletAuth('wallet-1');
    mocked(avatarService.getAvatar).mockResolvedValue({
      ...MOCK_AVATAR,
      creatorWallet: 'wallet-1',
    } as any);

    const event = makeEvent({ method: 'GET', path: '/avatars/avatar-1' });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
  });

  it('returns avatar for inhabitant wallet', async () => {
    setupWalletAuth('inhabitant-wallet');
    mocked(avatarService.getAvatar).mockResolvedValue({
      ...MOCK_AVATAR,
      creatorWallet: 'other-wallet',
      inhabitantWallet: 'inhabitant-wallet',
    } as any);

    const event = makeEvent({ method: 'GET', path: '/avatars/avatar-1' });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
  });
});

// =========================================================================
// PUT /avatars/{id} - Update Avatar
// =========================================================================
describe('PUT /avatars/{id}', () => {
  it('updates avatar for admin', async () => {
    setupAdminAuth();
    const updated = { ...MOCK_AVATAR, name: 'Updated' };
    mocked(avatarService.updateAvatar).mockResolvedValue(updated as any);

    const event = makeEvent({
      method: 'PUT',
      path: '/avatars/avatar-1',
      body: JSON.stringify({ name: 'Updated' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(parseBody(result).name).toBe('Updated');
  });

  it('returns 403 for non-admin without wallet', async () => {
    setupNonAdminNoWallet();
    const event = makeEvent({
      method: 'PUT',
      path: '/avatars/avatar-1',
      body: JSON.stringify({ name: 'Nope' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(403);
  });

  it('returns 404 for non-owner wallet user', async () => {
    setupWalletAuth('other-wallet');
    mocked(avatarService.getAvatar).mockResolvedValue({
      ...MOCK_AVATAR,
      creatorWallet: 'wallet-1',
      inhabitantWallet: null,
    } as any);

    const event = makeEvent({
      method: 'PUT',
      path: '/avatars/avatar-1',
      body: JSON.stringify({ name: 'Updated' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(404);
  });
});

// =========================================================================
// DELETE /avatars/{id}
// =========================================================================
describe('DELETE /avatars/{id}', () => {
  it('deletes avatar for admin', async () => {
    setupAdminAuth();
    mocked(avatarService.deleteAvatar).mockResolvedValue(undefined);

    const event = makeEvent({ method: 'DELETE', path: '/avatars/avatar-1' });
    const result = await handler(event);
    expect(result.statusCode).toBe(204);
  });

  it('returns 403 for non-admin without wallet', async () => {
    setupNonAdminNoWallet();
    const event = makeEvent({ method: 'DELETE', path: '/avatars/avatar-1' });
    const result = await handler(event);
    expect(result.statusCode).toBe(403);
  });

  it('returns 404 when wallet user is not creator', async () => {
    setupWalletAuth('other-wallet');
    mocked(avatarService.getAvatar).mockResolvedValue({
      ...MOCK_AVATAR,
      creatorWallet: 'wallet-1',
    } as any);

    const event = makeEvent({ method: 'DELETE', path: '/avatars/avatar-1' });
    const result = await handler(event);
    expect(result.statusCode).toBe(404);
  });

  it('allows creator wallet to delete', async () => {
    setupWalletAuth('wallet-1');
    mocked(avatarService.getAvatar).mockResolvedValue({
      ...MOCK_AVATAR,
      creatorWallet: 'wallet-1',
    } as any);
    mocked(avatarService.deleteAvatar).mockResolvedValue(undefined);

    const event = makeEvent({ method: 'DELETE', path: '/avatars/avatar-1' });
    const result = await handler(event);
    expect(result.statusCode).toBe(204);
  });
});

// =========================================================================
// POST /avatars/{id}/activate
// =========================================================================
describe('POST /avatars/{id}/activate', () => {
  it('activates avatar when prerequisites met', async () => {
    setupAdminAuth();
    const avatar = {
      ...MOCK_AVATAR,
      platforms: { telegram: { enabled: true, botUsername: 'TestBot' } },
    };
    mocked(avatarService.getAvatar).mockResolvedValue(avatar as any);
    mocked(avatarService.activateAvatar).mockResolvedValue({ success: true } as any);
    mocked(entitlementsService.getEntitlement).mockResolvedValue(null as any);

    const event = makeEvent({ method: 'POST', path: '/avatars/avatar-1/activate' });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(parseBody(result).success).toBe(true);
    expect(parseBody(result).status).toBe('active');
  });

  it('returns 404 for non-existent avatar', async () => {
    setupAdminAuth();
    mocked(avatarService.getAvatar).mockResolvedValue(null);

    const event = makeEvent({ method: 'POST', path: '/avatars/avatar-1/activate' });
    const result = await handler(event);
    expect(result.statusCode).toBe(404);
  });

  it('returns 403 for non-owner', async () => {
    setupWalletAuth('other-wallet');
    mocked(avatarService.getAvatar).mockResolvedValue({
      ...MOCK_AVATAR,
      creatorWallet: 'wallet-1',
      inhabitantWallet: null,
    } as any);

    const event = makeEvent({ method: 'POST', path: '/avatars/avatar-1/activate' });
    const result = await handler(event);
    expect(result.statusCode).toBe(403);
  });

  it('returns 400 when no platforms enabled', async () => {
    setupAdminAuth();
    mocked(avatarService.getAvatar).mockResolvedValue({
      ...MOCK_AVATAR,
      platforms: {},
    } as any);

    const event = makeEvent({ method: 'POST', path: '/avatars/avatar-1/activate' });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(parseBody(result).issues).toBeDefined();
    expect(parseBody(result).issues.length).toBeGreaterThan(0);
  });

  it('returns 400 when telegram enabled but botUsername missing', async () => {
    setupAdminAuth();
    mocked(avatarService.getAvatar).mockResolvedValue({
      ...MOCK_AVATAR,
      platforms: { telegram: { enabled: true } },
    } as any);

    const event = makeEvent({ method: 'POST', path: '/avatars/avatar-1/activate' });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(parseBody(result).issues).toContain('Telegram bot username is required');
  });
});

// =========================================================================
// POST /avatars/{id}/deactivate
// =========================================================================
describe('POST /avatars/{id}/deactivate', () => {
  it('deactivates avatar', async () => {
    setupAdminAuth();
    mocked(avatarService.getAvatar).mockResolvedValue(MOCK_AVATAR as any);
    mocked(avatarService.deactivateAvatar).mockResolvedValue({ success: true } as any);

    const event = makeEvent({ method: 'POST', path: '/avatars/avatar-1/deactivate' });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(parseBody(result).status).toBe('paused');
  });

  it('returns 403 for non-owner', async () => {
    setupWalletAuth('other-wallet');
    mocked(avatarService.getAvatar).mockResolvedValue({
      ...MOCK_AVATAR,
      creatorWallet: 'wallet-1',
      inhabitantWallet: null,
    } as any);

    const event = makeEvent({ method: 'POST', path: '/avatars/avatar-1/deactivate' });
    const result = await handler(event);
    expect(result.statusCode).toBe(403);
  });
});

// =========================================================================
// PUT /avatars/{id}/reassign - Admin-only
// =========================================================================
describe('PUT /avatars/{id}/reassign', () => {
  it('reassigns avatar for admin', async () => {
    setupAdminAuth();
    mocked(avatarService.getAvatar).mockResolvedValue(MOCK_AVATAR as any);
    mocked(avatarService.reassignAvatar).mockResolvedValue({ ...MOCK_AVATAR, creatorWallet: 'new-wallet' } as any);

    const event = makeEvent({
      method: 'PUT',
      path: '/avatars/avatar-1/reassign',
      body: JSON.stringify({ creatorWallet: 'new-wallet' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
  });

  it('returns 403 for non-admin', async () => {
    setupWalletAuth('wallet-1');
    const event = makeEvent({
      method: 'PUT',
      path: '/avatars/avatar-1/reassign',
      body: JSON.stringify({ creatorWallet: 'new-wallet' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(403);
    expect(parseBody(result).error).toContain('Admin access required');
  });

  it('returns 404 for non-existent avatar', async () => {
    setupAdminAuth();
    mocked(avatarService.getAvatar).mockResolvedValue(null);

    const event = makeEvent({
      method: 'PUT',
      path: '/avatars/avatar-1/reassign',
      body: JSON.stringify({ creatorWallet: 'new-wallet' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(404);
  });
});

// =========================================================================
// PUT/DELETE /avatars/{id}/orb - Orb slot/unslot
// =========================================================================
describe('PUT /avatars/{id}/orb', () => {
  it('slots an Orb NFT', async () => {
    setupWalletAuth('wallet-1');
    mocked(avatarService.getAvatar).mockResolvedValue({
      ...MOCK_AVATAR,
      creatorWallet: 'wallet-1',
    } as any);
    mocked(orbSlotsService.slotOrbToAvatar).mockResolvedValue({ success: true } as any);

    const event = makeEvent({
      method: 'PUT',
      path: '/avatars/avatar-1/orb',
      body: JSON.stringify({ mintAddress: 'mint-abc' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(parseBody(result).success).toBe(true);
  });

  it('returns 403 without wallet', async () => {
    setupAdminAuth();
    // Admin but no wallet session
    const event = makeEvent({
      method: 'PUT',
      path: '/avatars/avatar-1/orb',
      body: JSON.stringify({ mintAddress: 'mint-abc' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(403);
    expect(parseBody(result).error).toContain('Wallet sign-in required');
  });

  it('returns 400 when mintAddress missing', async () => {
    setupWalletAuth('wallet-1');
    mocked(avatarService.getAvatar).mockResolvedValue({
      ...MOCK_AVATAR,
      creatorWallet: 'wallet-1',
    } as any);

    const event = makeEvent({
      method: 'PUT',
      path: '/avatars/avatar-1/orb',
      body: JSON.stringify({}),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(parseBody(result).error).toContain('mintAddress is required');
  });

  it('returns 404 for non-existent avatar', async () => {
    setupWalletAuth('wallet-1');
    mocked(avatarService.getAvatar).mockResolvedValue(null);

    const event = makeEvent({
      method: 'PUT',
      path: '/avatars/avatar-1/orb',
      body: JSON.stringify({ mintAddress: 'mint-abc' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(404);
  });
});

describe('DELETE /avatars/{id}/orb', () => {
  it('unslots an Orb NFT', async () => {
    setupWalletAuth('wallet-1');
    mocked(avatarService.getAvatar).mockResolvedValue({
      ...MOCK_AVATAR,
      creatorWallet: 'wallet-1',
    } as any);
    mocked(orbSlotsService.unslotOrbFromAvatar).mockResolvedValue({ success: true } as any);

    const event = makeEvent({ method: 'DELETE', path: '/avatars/avatar-1/orb' });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(parseBody(result).success).toBe(true);
  });
});

// =========================================================================
// GET /avatars/{id}/entitlement
// =========================================================================
describe('GET /avatars/{id}/entitlement', () => {
  it('returns entitlement for admin', async () => {
    setupAdminAuth();
    mocked(avatarService.getAvatar).mockResolvedValue(MOCK_AVATAR as any);
    mocked(entitlementsService.getEntitlement).mockResolvedValue({ plan: 'free' } as any);

    const event = makeEvent({ method: 'GET', path: '/avatars/avatar-1/entitlement' });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(parseBody(result).entitlement.plan).toBe('free');
  });

  it('returns 404 for non-existent avatar', async () => {
    setupAdminAuth();
    mocked(avatarService.getAvatar).mockResolvedValue(null);

    const event = makeEvent({ method: 'GET', path: '/avatars/avatar-1/entitlement' });
    const result = await handler(event);
    expect(result.statusCode).toBe(404);
  });
});

// =========================================================================
// PUT /avatars/{id}/entitlement
// =========================================================================
describe('PUT /avatars/{id}/entitlement', () => {
  it('sets entitlement for admin', async () => {
    setupAdminAuth();
    // Need walletSession for accountId
    mocked(sessionCookie.getSessionFromCookie).mockReturnValue('session-tok');
    mocked(walletAuth.getSessionWithUser).mockResolvedValue({
      walletAddress: 'admin-wallet',
      sessionToken: 'session-tok',
      accountId: 'acc-1',
      isOrbHolder: false,
      user: {} as any,
    });
    mocked(avatarService.getAvatar).mockResolvedValue(MOCK_AVATAR as any);
    mocked(entitlementsService.setEntitlement).mockResolvedValue({ plan: 'pro' } as any);
    mocked(entitlementsService.getEntitlement).mockResolvedValue({ plan: 'pro' } as any);

    const event = makeEvent({
      method: 'PUT',
      path: '/avatars/avatar-1/entitlement',
      body: JSON.stringify({ plan: 'pro' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
  });

  it('returns 400 for invalid plan', async () => {
    setupAdminAuth();
    mocked(avatarService.getAvatar).mockResolvedValue(MOCK_AVATAR as any);

    const event = makeEvent({
      method: 'PUT',
      path: '/avatars/avatar-1/entitlement',
      body: JSON.stringify({ plan: 'ultra-premium' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(parseBody(result).error).toContain('Invalid plan');
  });

  it('returns 403 for non-admin', async () => {
    setupWalletAuth('wallet-1');
    const event = makeEvent({
      method: 'PUT',
      path: '/avatars/avatar-1/entitlement',
      body: JSON.stringify({ plan: 'pro' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(403);
  });
});

// =========================================================================
// GET /avatars/{id}/effective-limits
// =========================================================================
describe('GET /avatars/{id}/effective-limits', () => {
  it('returns effective limits for admin', async () => {
    setupAdminAuth();
    mocked(avatarService.getAvatar).mockResolvedValue(MOCK_AVATAR as any);
    mocked(entitlementsService.getEntitlement).mockResolvedValue(null as any);

    const event = makeEvent({ method: 'GET', path: '/avatars/avatar-1/effective-limits' });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(parseBody(result).plan).toBe('free');
  });
});

// =========================================================================
// POST /avatars/{id}/secrets
// =========================================================================
describe('POST /avatars/{id}/secrets', () => {
  it('stores a secret for admin', async () => {
    setupAdminAuth();
    mocked(secretsService.storeSecret).mockResolvedValue(undefined);

    const event = makeEvent({
      method: 'POST',
      path: '/avatars/avatar-1/secrets',
      body: JSON.stringify({ key: 'openai_api_key', value: 'sk-test-123' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(parseBody(result).success).toBe(true);
    expect(parseBody(result).message).toContain('openai_api_key');
  });

  it('returns 400 for missing key or value', async () => {
    setupAdminAuth();
    const event = makeEvent({
      method: 'POST',
      path: '/avatars/avatar-1/secrets',
      body: JSON.stringify({ key: 'openai_api_key' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(parseBody(result).error).toContain('key and value are required');
  });

  it('returns 400 for unsupported secret type', async () => {
    setupAdminAuth();
    const event = makeEvent({
      method: 'POST',
      path: '/avatars/avatar-1/secrets',
      body: JSON.stringify({ key: 'unknown_secret', value: 'val' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(parseBody(result).error).toContain('Unsupported secret key');
  });
});

// =========================================================================
// GET /avatars/{id}/secrets
// =========================================================================
describe('GET /avatars/{id}/secrets', () => {
  it('lists secret metadata for admin', async () => {
    setupAdminAuth();
    const secrets = [{ secretType: 'openai_api_key', name: 'default' }];
    mocked(secretsService.listSecrets).mockResolvedValue(secrets as any);

    const event = makeEvent({ method: 'GET', path: '/avatars/avatar-1/secrets' });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(parseBody(result)).toHaveLength(1);
  });
});

// =========================================================================
// GET /avatars/{id}/integrations
// =========================================================================
describe('GET /avatars/{id}/integrations', () => {
  it('lists integration statuses for admin', async () => {
    setupAdminAuth();
    mocked(avatarService.getAvatar).mockResolvedValue(MOCK_AVATAR as any);
    mocked(integrationsService.getAllIntegrationStatuses).mockResolvedValue({
      telegram: { configured: true },
    } as any);

    const event = makeEvent({ method: 'GET', path: '/avatars/avatar-1/integrations' });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(parseBody(result).integrations.telegram.configured).toBe(true);
  });

  it('returns 404 for non-owner wallet user', async () => {
    setupWalletAuth('other-wallet');
    mocked(avatarService.getAvatar).mockResolvedValue({
      ...MOCK_AVATAR,
      creatorWallet: 'wallet-1',
      inhabitantWallet: null,
    } as any);

    const event = makeEvent({ method: 'GET', path: '/avatars/avatar-1/integrations' });
    const result = await handler(event);
    expect(result.statusCode).toBe(404);
  });
});

// =========================================================================
// GET /avatars/{id}/energy
// =========================================================================
describe('GET /avatars/{id}/energy', () => {
  it('returns energy status for admin', async () => {
    setupAdminAuth();
    mocked(avatarService.getAvatar).mockResolvedValue(MOCK_AVATAR as any);
    mocked(energyService.getEnergyStatus).mockResolvedValue({
      current: 50,
      max: 100,
      refillPerHour: 5,
      nextRefillIn: 600,
    } as any);
    mocked(energyService.getEnergyBankBalance).mockResolvedValue({ credits: 10 } as any);

    const event = makeEvent({ method: 'GET', path: '/avatars/avatar-1/energy' });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    const body = parseBody(result);
    expect(body.current).toBe(50);
    expect(body.bankCredits).toBe(10);
    expect(body.costs).toBeDefined();
  });
});

// =========================================================================
// POST /avatars/{id}/energy/set - Admin only
// =========================================================================
describe('POST /avatars/{id}/energy/set', () => {
  it('sets energy for admin', async () => {
    setupAdminAuth();
    mocked(energyService.setEnergy).mockResolvedValue({ success: true, newValue: 75 } as any);
    mocked(entitlementsService.getEntitlement).mockResolvedValue(null as any);

    const event = makeEvent({
      method: 'POST',
      path: '/avatars/avatar-1/energy/set',
      body: JSON.stringify({ value: 75 }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(parseBody(result).newValue).toBe(75);
  });

  it('returns 403 for non-admin', async () => {
    setupWalletAuth('wallet-1');
    const event = makeEvent({
      method: 'POST',
      path: '/avatars/avatar-1/energy/set',
      body: JSON.stringify({ value: 75 }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(403);
  });

  it('returns 400 for negative value', async () => {
    setupAdminAuth();
    const event = makeEvent({
      method: 'POST',
      path: '/avatars/avatar-1/energy/set',
      body: JSON.stringify({ value: -5 }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 for non-number value', async () => {
    setupAdminAuth();
    const event = makeEvent({
      method: 'POST',
      path: '/avatars/avatar-1/energy/set',
      body: JSON.stringify({ value: 'abc' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });
});

// =========================================================================
// POST /avatars/{id}/energy/add - Admin only
// =========================================================================
describe('POST /avatars/{id}/energy/add', () => {
  it('adds energy for admin', async () => {
    setupAdminAuth();
    mocked(energyService.addEnergy).mockResolvedValue({ success: true, newValue: 80 } as any);
    mocked(entitlementsService.getEntitlement).mockResolvedValue(null as any);

    const event = makeEvent({
      method: 'POST',
      path: '/avatars/avatar-1/energy/add',
      body: JSON.stringify({ amount: 10 }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(parseBody(result).newValue).toBe(80);
  });

  it('returns 400 for non-number amount', async () => {
    setupAdminAuth();
    const event = makeEvent({
      method: 'POST',
      path: '/avatars/avatar-1/energy/add',
      body: JSON.stringify({ amount: 'lots' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });
});

// =========================================================================
// POST /avatars/{id}/tools/{toolCallId}
// =========================================================================
describe('POST /avatars/{id}/tools/{toolCallId}', () => {
  it('resumes chat after tool result', async () => {
    setupAdminAuth();
    mocked(chatHandler.resumeChatAfterToolResult).mockResolvedValue({
      response: 'Done!',
      history: [],
      media: [],
      pendingJobs: [],
      pendingToolCall: undefined,
      avatarUpdates: undefined,
    } as any);

    const event = makeEvent({
      method: 'POST',
      path: '/avatars/avatar-1/tools/call-123',
      body: JSON.stringify({ result: { confirmed: true } }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(parseBody(result).response).toBe('Done!');
  });

  it('returns 400 when result is missing', async () => {
    setupAdminAuth();
    const event = makeEvent({
      method: 'POST',
      path: '/avatars/avatar-1/tools/call-123',
      body: JSON.stringify({}),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(parseBody(result).error).toContain('result is required');
  });
});

// =========================================================================
// GET /avatars/{id}/events
// =========================================================================
describe('GET /avatars/{id}/events', () => {
  it('returns events for admin', async () => {
    setupAdminAuth();
    mocked(avatarEventsService.listAvatarEvents).mockResolvedValue([{ id: 'ev-1' }] as any);

    const event = makeEvent({ method: 'GET', path: '/avatars/avatar-1/events' });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(parseBody(result).events).toHaveLength(1);
  });

  it('returns 403 for non-admin', async () => {
    setupWalletAuth('wallet-1');
    const event = makeEvent({ method: 'GET', path: '/avatars/avatar-1/events' });
    const result = await handler(event);
    expect(result.statusCode).toBe(403);
  });
});

// =========================================================================
// PATCH /avatars/{id}/events/{eventId}
// =========================================================================
describe('PATCH /avatars/{id}/events/{eventId}', () => {
  it('updates issue status for admin', async () => {
    setupAdminAuth();
    mocked(avatarEventsService.updateIssueStatus).mockResolvedValue(undefined);

    const event = makeEvent({
      method: 'PATCH',
      path: '/avatars/avatar-1/events/ev-1',
      body: JSON.stringify({ status: 'resolved' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(parseBody(result).status).toBe('resolved');
  });

  it('returns 400 for invalid status', async () => {
    setupAdminAuth();
    const event = makeEvent({
      method: 'PATCH',
      path: '/avatars/avatar-1/events/ev-1',
      body: JSON.stringify({ status: 'invalid_status' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });
});

// =========================================================================
// GET /system/status
// =========================================================================
describe('GET /system/status', () => {
  it('returns system status for admin', async () => {
    setupAdminAuth();
    mocked(observabilityService.getSystemStatus).mockResolvedValue({ healthy: true } as any);

    const event = makeEvent({ method: 'GET', path: '/system/status' });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(parseBody(result).healthy).toBe(true);
  });

  it('returns 403 for non-admin', async () => {
    setupWalletAuth('wallet-1');
    const event = makeEvent({ method: 'GET', path: '/system/status' });
    const result = await handler(event);
    expect(result.statusCode).toBe(403);
    expect(parseBody(result).error).toContain('Admin access required');
  });
});

// =========================================================================
// GET /integrations/models
// =========================================================================
describe('GET /integrations/models', () => {
  it('returns all models when no integration specified', async () => {
    setupAdminAuth();
    mocked(integrationsService.getAvailableModelsForIntegration).mockReturnValue({ chat: ['model-1'] } as any);

    const event = makeEvent({ method: 'GET', path: '/integrations/models' });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(parseBody(result).integrations).toBeDefined();
  });

  it('returns models for specific integration', async () => {
    setupAdminAuth();
    mocked(integrationsService.getAvailableModelsForIntegration).mockReturnValue({ chat: ['model-1'] } as any);

    const event = makeEvent({
      method: 'GET',
      path: '/integrations/models',
      queryStringParameters: { integration: 'openai' },
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(parseBody(result).integration).toBe('openai');
  });

  it('returns 400 for unknown integration', async () => {
    setupAdminAuth();
    const event = makeEvent({
      method: 'GET',
      path: '/integrations/models',
      queryStringParameters: { integration: 'unknown_vendor' },
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(parseBody(result).error).toContain('Unknown integration');
  });
});

// =========================================================================
// 404 Not Found
// =========================================================================
describe('unmatched routes', () => {
  it('returns 404 for unknown path', async () => {
    setupAdminAuth();
    const event = makeEvent({ method: 'GET', path: '/unknown/path' });
    const result = await handler(event);
    expect(result.statusCode).toBe(404);
    expect(parseBody(result).error).toBe('Not found');
  });
});

// =========================================================================
// Error handling
// =========================================================================
describe('error handling', () => {
  it('returns 401 for auth errors', async () => {
    mocked(auth.authenticateRequest).mockRejectedValue(new Error('No authentication token provided'));

    const event = makeEvent({ method: 'GET', path: '/avatars' });
    const result = await handler(event);
    expect(result.statusCode).toBe(401);
  });

  it('returns AuthError status code', async () => {
    const { AuthError } = await import('../auth/errors.js');
    mocked(auth.authenticateRequest).mockRejectedValue(new AuthError('Slots full', 403, { limit: 50 }));

    const event = makeEvent({ method: 'GET', path: '/avatars' });
    const result = await handler(event);
    expect(result.statusCode).toBe(403);
    expect(parseBody(result).error).toBe('Slots full');
  });

  it('returns 500 for unexpected errors', async () => {
    mocked(auth.authenticateRequest).mockRejectedValue(new Error('Database connection failed'));

    const event = makeEvent({ method: 'GET', path: '/avatars' });
    const result = await handler(event);
    expect(result.statusCode).toBe(500);
    expect(parseBody(result).error).toBe('Internal server error');
  });
});

// =========================================================================
// POST /avatars/{id}/validate-token
// =========================================================================
describe('POST /avatars/{id}/validate-token', () => {
  it('returns 400 when type and value are missing', async () => {
    setupAdminAuth();
    const event = makeEvent({
      method: 'POST',
      path: '/avatars/avatar-1/validate-token',
      body: JSON.stringify({}),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 for unsupported secret type', async () => {
    setupAdminAuth();
    const event = makeEvent({
      method: 'POST',
      path: '/avatars/avatar-1/validate-token',
      body: JSON.stringify({ type: 'banana_token', value: 'val' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(parseBody(result).error).toContain('Unsupported secret type');
  });
});

// =========================================================================
// POST /avatars/{id}/validate-ai-key
// =========================================================================
describe('POST /avatars/{id}/validate-ai-key', () => {
  it('returns 400 for missing integration or value', async () => {
    setupAdminAuth();
    const event = makeEvent({
      method: 'POST',
      path: '/avatars/avatar-1/validate-ai-key',
      body: JSON.stringify({}),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(parseBody(result).error).toContain('integration and value are required');
  });

  it('returns 400 for unsupported integration', async () => {
    setupAdminAuth();
    const event = makeEvent({
      method: 'POST',
      path: '/avatars/avatar-1/validate-ai-key',
      body: JSON.stringify({ integration: 'deepseek', value: 'key-123' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(parseBody(result).error).toContain('Unsupported integration');
  });

  it('validates anthropic key format', async () => {
    setupAdminAuth();
    const event = makeEvent({
      method: 'POST',
      path: '/avatars/avatar-1/validate-ai-key',
      body: JSON.stringify({ integration: 'anthropic', value: 'sk-ant-something-long-enough' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(parseBody(result).valid).toBe(true);
  });

  it('rejects short anthropic key', async () => {
    setupAdminAuth();
    const event = makeEvent({
      method: 'POST',
      path: '/avatars/avatar-1/validate-ai-key',
      body: JSON.stringify({ integration: 'anthropic', value: 'short' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(parseBody(result).valid).toBe(false);
  });
});

// =========================================================================
// PUT /avatars/{id}/twitter/moderation
// =========================================================================
describe('PUT /avatars/{id}/twitter/moderation', () => {
  it('returns 400 for invalid mode', async () => {
    setupAdminAuth();
    mocked(avatarService.getAvatar).mockResolvedValue(MOCK_AVATAR as any);

    const event = makeEvent({
      method: 'PUT',
      path: '/avatars/avatar-1/twitter/moderation',
      body: JSON.stringify({ mode: 'invalid' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(parseBody(result).error).toContain('Valid mode required');
  });
});

// =========================================================================
// GET /avatars/{id}/logs (admin only)
// =========================================================================
describe('GET /avatars/{id}/logs', () => {
  it('returns 403 for non-admin', async () => {
    setupWalletAuth('wallet-1');
    const event = makeEvent({ method: 'GET', path: '/avatars/avatar-1/logs' });
    const result = await handler(event);
    expect(result.statusCode).toBe(403);
    expect(parseBody(result).error).toContain('Admin access required');
  });
});

// =========================================================================
// POST /api-keys (wildcard, admin only)
// =========================================================================
describe('POST /api-keys', () => {
  it('returns 403 for non-admin', async () => {
    setupWalletAuth('wallet-1');
    const event = makeEvent({
      method: 'POST',
      path: '/api-keys',
      body: JSON.stringify({ name: 'Test Key' }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(403);
    expect(parseBody(result).error).toContain('Admin access required');
  });
});
