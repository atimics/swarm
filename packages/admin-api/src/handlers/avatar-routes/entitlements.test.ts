/**
 * Tests for avatar-routes/entitlements.ts
 *
 * Routes:
 *   PUT / DELETE /avatars/{id}/orb
 *   GET / PUT    /avatars/{id}/entitlement
 *   GET          /avatars/{id}/effective-limits
 *   POST         /avatars/{id}/activate
 *   POST         /avatars/{id}/deactivate
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ── Mock state ─────────────────────────────────────────────────────────────
let getAvatarResult: unknown = null;
let slotOrbResult: unknown = { success: true };
let unslotOrbResult: unknown = { success: true };
let getEntitlementResult: unknown = null;
let setEntitlementResult: unknown = {};
let effectiveLimitsResult: unknown = { plan: 'free', limits: {}, source: 'default', entitlementStatus: 'active' };
let activateResult: unknown = { success: true };
let deactivateResult: unknown = { success: true };

mock.module('../../services/avatars.js', () => ({
  getAvatar: async () => getAvatarResult,
  activateAvatar: async () => activateResult,
  deactivateAvatar: async () => deactivateResult,
}));

mock.module('../../services/orb-slots.js', () => ({
  slotOrbToAvatar: async () => slotOrbResult,
  unslotOrbFromAvatar: async () => unslotOrbResult,
}));

mock.module('../../services/entitlements.js', () => ({
  getEntitlement: async () => getEntitlementResult,
  setEntitlement: async () => setEntitlementResult,
}));

mock.module('../../services/runtime-limits.js', () => ({
  getEffectiveLimitsForAvatar: () => effectiveLimitsResult,
  toRuntimeLimits: () => ({}),
  syncRuntimeLimitsToState: async () => {},
}));

mock.module('./runtime-sync.js', () => ({
  syncRuntimeContractForAvatar: async () => {},
  buildRuntimeAugmentations: async () => undefined,
}));

mock.module('@swarm/core', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, setContext: () => {} },
}));

// ── Import AFTER mocks ────────────────────────────────────────────────────
import { handleEntitlementRoutes } from './entitlements.js';
import { makeCtx, parseBody, MOCK_AVATAR } from './test-helpers.js';

beforeEach(() => {
  getAvatarResult = null;
  slotOrbResult = { success: true };
  unslotOrbResult = { success: true };
  getEntitlementResult = null;
  setEntitlementResult = { plan: 'pro' };
  effectiveLimitsResult = { plan: 'free', limits: {}, source: 'default', entitlementStatus: 'active' };
  activateResult = { success: true };
  deactivateResult = { success: true };
});

// =========================================================================
// PUT /avatars/{id}/orb
// =========================================================================
describe('PUT /avatars/{id}/orb', () => {
  it('slots orb for owner', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    const ctx = makeCtx({
      method: 'PUT',
      path: '/avatars/avatar-1/orb',
      body: JSON.stringify({ mintAddress: 'mint-1' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    expect(parseBody(result!)).toEqual({ success: true, avatarId: 'avatar-1', mintAddress: 'mint-1' });
  });

  it('requires wallet sign-in', async () => {
    const ctx = makeCtx({
      method: 'PUT',
      path: '/avatars/avatar-1/orb',
      body: JSON.stringify({ mintAddress: 'mint-1' }),
      walletAddress: null,
      effectiveIsAdmin: false,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(403);
  });

  it('returns 404 when avatar not found', async () => {
    getAvatarResult = null;
    const ctx = makeCtx({
      method: 'PUT',
      path: '/avatars/avatar-1/orb',
      body: JSON.stringify({ mintAddress: 'mint-1' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(404);
  });
});

// =========================================================================
// DELETE /avatars/{id}/orb
// =========================================================================
describe('DELETE /avatars/{id}/orb', () => {
  it('unslots orb for owner', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    const ctx = makeCtx({
      method: 'DELETE',
      path: '/avatars/avatar-1/orb',
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(200);
  });
});

// =========================================================================
// GET /avatars/{id}/entitlement
// =========================================================================
describe('GET /avatars/{id}/entitlement', () => {
  it('returns entitlement for admin', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    getEntitlementResult = { plan: 'pro', status: 'active' };
    const ctx = makeCtx({ method: 'GET', path: '/avatars/avatar-1/entitlement', effectiveIsAdmin: true });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { avatarId: string; entitlement: unknown };
    expect(body.avatarId).toBe('avatar-1');
    expect(body.entitlement).toEqual({ plan: 'pro', status: 'active' });
  });

  it('returns 404 when avatar not found', async () => {
    getAvatarResult = null;
    const ctx = makeCtx({ method: 'GET', path: '/avatars/avatar-1/entitlement', effectiveIsAdmin: true });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(404);
  });
});

// =========================================================================
// PUT /avatars/{id}/entitlement
// =========================================================================
describe('PUT /avatars/{id}/entitlement', () => {
  it('admin sets entitlement', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    setEntitlementResult = { plan: 'pro', status: 'active' };
    const ctx = makeCtx({
      method: 'PUT',
      path: '/avatars/avatar-1/entitlement',
      body: JSON.stringify({ plan: 'pro', accountId: 'acc-1' }),
      effectiveIsAdmin: true,
      accountId: 'acc-1',
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(200);
  });

  it('non-admin gets 403', async () => {
    const ctx = makeCtx({
      method: 'PUT',
      path: '/avatars/avatar-1/entitlement',
      body: JSON.stringify({ plan: 'pro' }),
      effectiveIsAdmin: false,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(403);
  });

  it('rejects invalid plan', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    const ctx = makeCtx({
      method: 'PUT',
      path: '/avatars/avatar-1/entitlement',
      body: JSON.stringify({ plan: 'invalid' }),
      effectiveIsAdmin: true,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(400);
  });
});

// =========================================================================
// GET /avatars/{id}/effective-limits
// =========================================================================
describe('GET /avatars/{id}/effective-limits', () => {
  it('returns effective limits', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    const ctx = makeCtx({ method: 'GET', path: '/avatars/avatar-1/effective-limits', effectiveIsAdmin: true });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { plan: string };
    expect(body.plan).toBe('free');
  });
});

// =========================================================================
// POST /avatars/{id}/activate
// =========================================================================
describe('POST /avatars/{id}/activate', () => {
  it('activates avatar with platform enabled', async () => {
    getAvatarResult = {
      ...MOCK_AVATAR,
      status: 'draft',
      platforms: { telegram: { enabled: true, botUsername: 'mybot' } },
    };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/activate',
      effectiveIsAdmin: true,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { success: boolean; status: string };
    expect(body.success).toBe(true);
    expect(body.status).toBe('active');
  });

  it('fails when no platform enabled', async () => {
    getAvatarResult = { ...MOCK_AVATAR, platforms: {} };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/activate',
      effectiveIsAdmin: true,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(400);
  });

  it('non-owner gets 403', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/activate',
      walletAddress: 'wallet-other',
      effectiveIsAdmin: false,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(403);
  });
});

// =========================================================================
// POST /avatars/{id}/deactivate
// =========================================================================
describe('POST /avatars/{id}/deactivate', () => {
  it('deactivates avatar', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/deactivate',
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { success: boolean; status: string };
    expect(body.status).toBe('paused');
  });
});

// =========================================================================
// Unmatched routes
// =========================================================================
describe('unmatched routes', () => {
  it('returns null', async () => {
    const ctx = makeCtx({ method: 'GET', path: '/unknown' });
    const result = await handleEntitlementRoutes(ctx);
    expect(result).toBeNull();
  });
});
