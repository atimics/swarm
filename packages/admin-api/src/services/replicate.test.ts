import { describe, it, expect } from 'bun:test';
import { validateReplicateApiKey } from './replicate.js';

describe('replicate api key validation', () => {
  it('rejects invalid key', async () => {
    const result = await validateReplicateApiKey('bad', {
      fetchFn: async () => new Response('{}', { status: 401 }),
    });

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid API key');
  });

  it('rejects when billing is disabled', async () => {
    const result = await validateReplicateApiKey('key', {
      fetchFn: async () => new Response(JSON.stringify({ type: 'free', billing_enabled: false }), { status: 200 }),
    });

    expect(result.valid).toBe(false);
    expect(result.error).toContain('billing');
  });

  it('accepts billed accounts', async () => {
    const result = await validateReplicateApiKey('key', {
      fetchFn: async () => new Response(JSON.stringify({ type: 'pro', billing_enabled: true }), { status: 200 }),
    });

    expect(result.valid).toBe(true);
    expect(result.accountType).toBe('pro');
  });
});
