import { describe, it, expect } from 'vitest';
import { createAvatarAccessChecker } from './chat-access.js';

const corsHeaders = { 'Access-Control-Allow-Origin': '*' };
const session = { email: 'test@example.com', userId: 'wallet-1', expiresAt: 0, isAdmin: false, accessToken: '' };

describe('chat access', () => {
  it('allows admin without checks', async () => {
    const ensureAccess = createAvatarAccessChecker({
      isAdmin: true,
      session,
      getAvatar: async () => null,
      corsHeaders,
    });

    const result = await ensureAccess('avatar-1');
    expect(result).toBe(null);
  });

  it('denies access to missing avatar', async () => {
    const ensureAccess = createAvatarAccessChecker({
      isAdmin: false,
      session,
      getAvatar: async () => null,
      corsHeaders,
    });

    const result = await ensureAccess('avatar-1');
    expect(result && typeof result !== 'string' ? result.statusCode : undefined).toBe(404);
  });

  it('denies access when wallet does not match', async () => {
    const ensureAccess = createAvatarAccessChecker({
      isAdmin: false,
      session,
      getAvatar: async () => ({ creatorWallet: 'wallet-2', inhabitantWallet: null }),
      corsHeaders,
    });

    const result = await ensureAccess('avatar-1');
    expect(result && typeof result !== 'string' ? result.statusCode : undefined).toBe(404);
  });

  it('allows access when wallet matches creator', async () => {
    const ensureAccess = createAvatarAccessChecker({
      isAdmin: false,
      session,
      getAvatar: async () => ({ creatorWallet: 'wallet-1', inhabitantWallet: null }),
      corsHeaders,
    });

    const result = await ensureAccess('avatar-1');
    expect(result).toBe(null);
  });

  it('allows public access only for the resolved public avatar id', async () => {
    const ensureAccess = createAvatarAccessChecker({
      isAdmin: false,
      session,
      getAvatar: async () => ({ creatorWallet: 'wallet-2', inhabitantWallet: null }),
      corsHeaders,
      publicAvatarId: 'avatar-1',
    });

    const allowed = await ensureAccess('avatar-1');
    expect(allowed).toBe(null);

    const denied = await ensureAccess('avatar-2');
    expect(denied && typeof denied !== 'string' ? denied.statusCode : undefined).toBe(404);
  });
});
