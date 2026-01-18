import { describe, it, expect } from 'bun:test';
import { createAvatarAccessChecker } from './chat-access.js';

const corsHeaders = { 'Access-Control-Allow-Origin': '*' };
const session = { email: 'test@example.com', userId: 'wallet-1', expiresAt: 0 };

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
    expect(result?.statusCode).toBe(404);
  });

  it('denies access when wallet does not match', async () => {
    const ensureAccess = createAvatarAccessChecker({
      isAdmin: false,
      session,
      getAvatar: async () => ({ creatorWallet: 'wallet-2', inhabitantWallet: null }),
      corsHeaders,
    });

    const result = await ensureAccess('avatar-1');
    expect(result?.statusCode).toBe(404);
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
});
