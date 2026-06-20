import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routeLocalApi } from './local-web-api';

const STORAGE_KEY = 'swarm:web-local:v1';

async function api(path: string, init?: RequestInit): Promise<Response> {
  const response = await routeLocalApi(new Request(`${window.location.origin}/api${path}`, init));
  if (!response) throw new Error(`Route was not handled: ${path}`);
  return response;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await api(path, init);
  expect(response.ok).toBe(true);
  return response.json() as Promise<T>;
}

describe('local web api', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('stores plan entitlements and exposes effective limits for browser-local avatars', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      avatars: [{
        avatarId: 'avatar-1',
        name: 'Local',
        status: 'draft',
        createdAt: 1,
        updatedAt: 1,
        createdBy: 'local-web',
      }],
      chats: {},
      secrets: {},
      avatarSecrets: {},
      agentBackends: {},
    }));

    const entitlement = await json<{ effective: { plan: string; source: string } }>('/avatars/avatar-1/entitlement', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'pro' }),
    });
    const limits = await json<{ plan: string; source: string; limits: Record<string, unknown> }>('/avatars/avatar-1/effective-limits');

    expect(entitlement.effective).toMatchObject({ plan: 'pro', source: 'entitlement' });
    expect(limits).toMatchObject({ plan: 'pro', source: 'entitlement' });
    expect(limits.limits.messagesPerDay).toBe(500);
  });

  it('returns zero-state usage and event payloads instead of route 404s', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      avatars: [{
        avatarId: 'avatar-1',
        name: 'Local',
        status: 'draft',
        createdAt: 1,
        updatedAt: 1,
        createdBy: 'local-web',
      }],
      chats: {},
      secrets: {},
      avatarSecrets: {},
      agentBackends: {},
    }));

    const usage = await json<{ avatarId: string; meters: { messages: { used: number } } }>('/avatars/avatar-1/usage');
    const history = await json<{ days: number; history: unknown[] }>('/avatars/avatar-1/usage/history?days=90');
    const events = await json<{ count: number; events: unknown[] }>('/avatars/avatar-1/events');
    const counts = await json<{ openIssues: number; recentFeedback: { positive: number } }>('/avatars/avatar-1/events/counts');
    const patch = await json<{ ok: boolean }>('/avatars/avatar-1/events/event-1', { method: 'PATCH' });

    expect(usage.avatarId).toBe('avatar-1');
    expect(usage.meters.messages.used).toBe(0);
    expect(history).toEqual({ avatarId: 'avatar-1', days: 30, history: [] });
    expect(events).toEqual({ avatarId: 'avatar-1', events: [], count: 0 });
    expect(counts).toEqual({ avatarId: 'avatar-1', openIssues: 0, recentFeedback: { positive: 0, negative: 0, neutral: 0 } });
    expect(patch.ok).toBe(true);
  });

  it('supports gallery upload/save and avatar api-key management locally', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      avatars: [{
        avatarId: 'avatar-1',
        name: 'Local',
        status: 'draft',
        createdAt: 1,
        updatedAt: 1,
        createdBy: 'local-web',
      }],
      chats: {},
      secrets: {},
      avatarSecrets: {},
      agentBackends: {},
    }));

    const upload = await json<{ uploadUrl: string; s3Key: string; publicUrl: string }>('/avatars/avatar-1/gallery/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: 'image/png' }),
    });
    const uploadResponse = await routeLocalApi(new Request(upload.uploadUrl, { method: 'PUT', body: 'image' }));
    const saved = await json<{ id: string; url: string }>('/avatars/avatar-1/gallery/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ s3Key: upload.s3Key, publicUrl: upload.publicUrl, caption: 'hello' }),
    });
    const gallery = await json<{ items: Array<{ id: string; url: string }> }>('/avatars/avatar-1/gallery');

    const createdKey = await json<{ apiKey: string; keyPrefix: string }>('/avatars/avatar-1/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test key' }),
    });
    const keys = await json<{ keys: Array<{ keyPrefix: string; name: string }> }>('/avatars/avatar-1/api-keys');
    await json<{ ok: boolean }>(`/avatars/avatar-1/api-keys/${encodeURIComponent(createdKey.keyPrefix)}`, { method: 'DELETE' });
    const afterDelete = await json<{ keys: Array<{ keyPrefix: string }> }>('/avatars/avatar-1/api-keys');

    expect(uploadResponse.ok).toBe(true);
    expect(saved.url).toBe(upload.publicUrl);
    expect(gallery.items).toHaveLength(1);
    expect(createdKey.apiKey).toContain(createdKey.keyPrefix);
    expect(keys.keys).toMatchObject([{ keyPrefix: createdKey.keyPrefix, name: 'Test key' }]);
    expect(afterDelete.keys).toEqual([]);
  });

  it('returns shaped local payloads for issues, telegram, and model catalog panels', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      avatars: [{
        avatarId: 'avatar-1',
        name: 'Local',
        status: 'draft',
        createdAt: 1,
        updatedAt: 1,
        createdBy: 'local-web',
        platforms: { telegram: { enabled: false, botUsername: 'local_bot' } },
      }],
      chats: {},
      secrets: {},
      avatarSecrets: {},
      agentBackends: {},
    }));

    const issues = await json<{ avatarId: string; issues: unknown[] }>('/avatars/avatar-1/issues');
    const telegramState = await json<{ platformEnabled: boolean; allowedChats: unknown[]; pendingDms: unknown[] }>('/avatars/avatar-1/telegram/state');
    const bindCode = await json<{ code: string; deepLink: string }>('/avatars/avatar-1/telegram/bind-code', { method: 'POST' });
    const diagnosis = await json<{ mode: string; issues: Array<{ message: string }> }>('/avatars/avatar-1/telegram/diagnose');
    const repair = await json<{ action: string; reason: string }>('/avatars/avatar-1/telegram/repair', { method: 'POST' });
    const knownUsers = await json<{ users: unknown[] }>('/avatars/avatar-1/telegram/known-users');
    const search = await json<{ results: Array<{ id: string; isDefault: boolean }> }>('/integrations/models/search?q=llama&integration=openrouter&capability=text');
    const catalog = await json<{ modelsByCapability: { text: Array<{ id: string }> } }>('/integrations/models?integration=openrouter');

    expect(issues).toEqual({ avatarId: 'avatar-1', issues: [] });
    expect(telegramState).toMatchObject({ platformEnabled: false, allowedChats: [], pendingDms: [] });
    expect(bindCode.code).toMatch(/^LOCAL-/);
    expect(bindCode.deepLink).toContain('local_bot');
    expect(diagnosis.issues[0].message).toContain('native or hosted app');
    expect(repair).toMatchObject({ action: 'skipped' });
    expect(knownUsers.users).toEqual([]);
    expect(search.results).toEqual([{ id: 'llama', name: 'llama', description: 'Browser-local placeholder model. Configure a runtime or provider for live inference.', isDefault: true }]);
    expect(catalog.modelsByCapability.text[0].id).toBe('local-browser');
  });

  it('supports local shared chat and wallet-link helper routes', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      avatars: [{
        avatarId: 'avatar-1',
        name: 'Local',
        description: 'Browser-local avatar',
        persona: 'Helpful',
        status: 'draft',
        createdAt: 1,
        updatedAt: 1,
        createdBy: 'local-web',
        platforms: { discord: { enabled: true } },
      }],
      chats: {},
      secrets: {},
      avatarSecrets: {},
      agentBackends: {},
    }));

    const identity = await json<{ sender: { walletAddress: string } }>('/shared-chat/identity');
    const avatar = await json<{ avatar: { avatarId: string; connectedPlatforms: string[] } }>('/shared-chat/avatar?channelId=local');
    const sent = await json<{ message: { content: string; sender: { walletAddress: string } } }>('/shared-chat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: 'local', content: 'hello' }),
    });
    const messages = await json<{ messages: Array<{ content: string }>; sender: { walletAddress: string }; avatar: null }>('/shared-chat/messages?channelId=local');
    const typing = await json<{ typing: boolean }>('/shared-chat/typing?channelId=local');
    const challenge = await json<{ nonce: string; message: string; expiresAt: string }>('/auth/link/wallet/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: 'Wallet111' }),
    });
    const verify = await json<{ linked: boolean }>('/auth/link/wallet/verify', { method: 'POST' });

    expect(identity.sender.walletAddress).toBe('local-web');
    expect(avatar.avatar).toMatchObject({ avatarId: 'avatar-1', connectedPlatforms: ['discord'] });
    expect(sent.message).toMatchObject({ content: 'hello', sender: { walletAddress: 'local-web' } });
    expect(messages.messages).toHaveLength(1);
    expect(messages.messages[0].content).toBe('hello');
    expect(messages.avatar).toBeNull();
    expect(typing.typing).toBe(false);
    expect(challenge.message).toContain('Wallet111');
    expect(new Date(challenge.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(verify.linked).toBe(true);
  });
});
