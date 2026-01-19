import { describe, expect, it, vi, afterEach } from 'vitest';

import { getTwitterConnectionStatus } from './twitter';

describe('getTwitterConnectionStatus', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns status payload from backend', async () => {
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ connected: true, username: 'testuser', userId: '123' }),
      } as any;
    }) as any;

    const result = await getTwitterConnectionStatus('avatar-123');
    expect(result.connected).toBe(true);
    expect(result.username).toBe('testuser');
    expect(result.userId).toBe('123');
  });

  it('throws on non-200', async () => {
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: 'nope' }),
      } as any;
    }) as any;

    await expect(getTwitterConnectionStatus('avatar-123')).rejects.toThrow('HTTP 500');
  });
});
