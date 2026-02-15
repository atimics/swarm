import { describe, it, expect, vi, afterEach } from 'vitest';

// Bun module mocks must be declared before importing the module under test.
// bun:test doesn't provide mock.fn(), so we use simple call tracking.
const storeSecretCalls: unknown[][] = [];
let getSecretValueResult: string | null = null;

const storeSecret = async (...args: unknown[]) => {
  storeSecretCalls.push(args);
  return {
    pk: 'AVATAR#avatar-1',
    sk: 'SECRET#moltbook_api_key#default',
    secretType: 'moltbook_api_key',
    name: 'default',
    secretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:swarm/avatar-1/moltbook_api_key/default',
    createdAt: Date.now(),
    createdBy: 'admin@example.com',
    updatedAt: Date.now(),
    updatedBy: 'admin@example.com',
    isGlobal: false,
  } as any;
};

const _getSecretValueInternal = async () => getSecretValueResult;

mock.module('./secrets.js', () => ({
  storeSecret,
  _getSecretValueInternal,
}));

describe('moltbook registration', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    storeSecretCalls.length = 0;
    getSecretValueResult = null;
  });

  it('registers and stores api key secret', async () => {
    getSecretValueResult = null;

    globalThis.fetch = (async (url: any, options?: any) => {
      expect(String(url)).toBe('https://www.moltbook.com/api/v1/agents/register');
      expect(options?.method).toBe('POST');
      expect(options?.headers?.['Content-Type']).toBe('application/json');

      const body = JSON.parse(options?.body);
      expect(body).toEqual({ name: 'MyAgent', description: 'Hello' });

      return new Response(JSON.stringify({
        agent: {
          api_key: 'moltbook_xxx',
          claim_url: 'https://www.moltbook.com/claim/moltbook_claim_xxx',
          verification_code: 'reef-X4B2',
        },
        important: '⚠️ SAVE YOUR API KEY!',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as any;

    const { createMoltbookServices } = await import('./moltbook.js');

    const session = {
      email: 'admin@example.com',
      userId: 'user-1',
      isAdmin: true,
      accessToken: 'token',
    };

    const services = createMoltbookServices('avatar-1', session as any);
    const result = await services.register!('MyAgent', 'Hello');

    expect(result).toEqual({
      apiKey: 'moltbook_xxx',
      claimUrl: 'https://www.moltbook.com/claim/moltbook_claim_xxx',
      verificationCode: 'reef-X4B2',
    });

    expect(storeSecretCalls.length).toBe(1);
    expect(storeSecretCalls[0]).toEqual([
      'avatar-1',
      'moltbook_api_key',
      'default',
      'moltbook_xxx',
      session,
      'Moltbook API key for avatar-1',
    ]);
  });

  it('refuses to re-register when api key already exists', async () => {
    getSecretValueResult = 'already';

    const { createMoltbookServices } = await import('./moltbook.js');

    const session = {
      email: 'admin@example.com',
      userId: 'user-1',
      isAdmin: true,
      accessToken: 'token',
    };

    const services = createMoltbookServices('avatar-1', session as any);

    await expect(services.register!('MyAgent', 'Hello')).rejects.toThrow(
      'Already registered on Moltbook'
    );

    expect(storeSecretCalls.length).toBe(0);
  });
});
