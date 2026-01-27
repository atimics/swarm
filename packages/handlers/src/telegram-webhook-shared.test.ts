import { describe, it, expect } from 'bun:test';

process.env.ADMIN_TABLE ||= 'ADMIN_TABLE';
process.env.STATE_TABLE ||= 'STATE_TABLE';
process.env.MESSAGE_QUEUE_URL ||= 'https://example.com/queue';

const modPromise = import('./telegram-webhook-shared.js');

describe('telegram-webhook-shared allowlists', () => {
  it('blocks DMs when allowedDmUserIds is missing/empty', async () => {
    const { isTelegramChatAllowed } = (await modPromise);
    const allowed = isTelegramChatAllowed(
      {
        conversationId: 'dm',
        sender: { id: 123 },
        metadata: { chatType: 'private' },
      },
      { allowedDmUserIds: [] }
    );

    expect(allowed).toBe(false);
  });

  it('allows DMs only for allowlisted user IDs (string-coerced)', async () => {
    const { isTelegramChatAllowed } = (await modPromise);
    const allowed = isTelegramChatAllowed(
      {
        conversationId: 'dm',
        sender: { id: 123 },
        metadata: { chatType: 'private' },
      },
      { allowedDmUserIds: ['123'] }
    );

    expect(allowed).toBe(true);
  });

  it('allows DMs only for allowlisted users using allowedDmUsers', async () => {
    const { isTelegramChatAllowed } = (await modPromise);
    const allowed = isTelegramChatAllowed(
      {
        conversationId: 'dm',
        sender: { id: 123 },
        metadata: { chatType: 'private' },
      },
      { allowedDmUsers: [{ userId: '123', username: 'alice' }] as unknown as Array<{ userId: string }> }
    );

    expect(allowed).toBe(true);
  });

  it('treats allowedDmUsers as authoritative when present (even if empty)', async () => {
    const { isTelegramChatAllowed } = (await modPromise);
    const allowed = isTelegramChatAllowed(
      {
        conversationId: 'dm',
        sender: { id: 123 },
        metadata: { chatType: 'private' },
      },
      {
        allowedDmUsers: [],
        allowedDmUserIds: ['123'],
      }
    );

    expect(allowed).toBe(false);
  });

  it('allows group chats when allowedChatIds is not configured', async () => {
    const { isTelegramChatAllowed } = (await modPromise);
    const allowed = isTelegramChatAllowed(
      {
        conversationId: '-1001',
        sender: { id: 'u1' },
        metadata: { chatType: 'supergroup' },
      },
      undefined
    );

    expect(allowed).toBe(true);
  });

  it('allows group chats when allowedChatIds is an empty array (no enforcement)', async () => {
    const { isTelegramChatAllowed } = (await modPromise);
    const allowed = isTelegramChatAllowed(
      {
        conversationId: '-1001',
        sender: { id: 'u1' },
        metadata: { chatType: 'group' },
      },
      { allowedChatIds: [] }
    );

    expect(allowed).toBe(true);
  });

  it('blocks non-private chats not present in allowedChatIds (when configured)', async () => {
    const { isTelegramChatAllowed } = (await modPromise);
    const allowed = isTelegramChatAllowed(
      {
        conversationId: '-1002',
        sender: { id: 'u1' },
        metadata: { chatType: 'group' },
      },
      { allowedChatIds: ['-1001'] }
    );

    expect(allowed).toBe(false);
  });

  it('treats allowedChatIds as home channels when homeChannelChecker is enabled', async () => {
    const { isTelegramChatAllowed } = (await modPromise);
    const allowed = isTelegramChatAllowed(
      {
        conversationId: '-1001',
        sender: { id: 'u1' },
        metadata: { chatType: 'supergroup' },
      },
      { allowedChatIds: ['-1001'], homeChannelId: '-9999' },
      { isHomeChannel: async () => false }
    );

    await expect(Promise.resolve(allowed)).resolves.toBe(true);
  });

  it('treats allowedChats as home channels when homeChannelChecker is enabled', async () => {
    const { isTelegramChatAllowed } = (await modPromise);
    const allowed = isTelegramChatAllowed(
      {
        conversationId: '-1001',
        sender: { id: 'u1' },
        metadata: { chatType: 'supergroup' },
      },
      { allowedChats: [{ chatId: '-1001', title: 'Test' }] as unknown as Array<{ chatId: string }>, homeChannelId: '-9999' },
      { isHomeChannel: async () => false }
    );

    await expect(Promise.resolve(allowed)).resolves.toBe(true);
  });

  it('blocks group chats when homeChannelChecker is enabled and chat is neither a home channel nor in allowedChatIds', async () => {
    const { isTelegramChatAllowed } = (await modPromise);
    const allowed = isTelegramChatAllowed(
      {
        conversationId: '-1002',
        sender: { id: 'u1' },
        metadata: { chatType: 'supergroup' },
      },
      { allowedChatIds: ['-1001'], homeChannelId: '-9999' },
      { isHomeChannel: async () => false }
    );

    await expect(Promise.resolve(allowed)).resolves.toBe(false);
  });
});

describe('telegram-webhook-shared home channel bootstrap', () => {
  it('bootstraps home channel from first group mention when none exists', async () => {
    const { maybeBootstrapHomeChannelFromGroupEngagement } = (await modPromise);

    const calls: Array<{ name: string; args: unknown[] }> = [];
    const deps = {
      registerHomeChannelFromWebhook: async (...args: unknown[]) => {
        calls.push({ name: 'register', args });
      },
      updateAvatarHomeChannel: async (...args: unknown[]) => {
        calls.push({ name: 'update', args });
      },
      logger: {
        info: () => {},
        warn: () => {},
      },
    };

    const bootstrapped = await maybeBootstrapHomeChannelFromGroupEngagement(
      {
        avatarId: 'a1',
        avatarConfig: {
          platforms: {
            telegram: {
              enabled: true,
              botUsername: 'DevilRATiBot',
            },
          },
        } as unknown as import('@swarm/core').AvatarConfig,
        envelope: {
          conversationId: '-1001',
          metadata: {
            chatType: 'supergroup',
            chatTitle: 'My Group',
            isMention: true,
          },
        },
      },
      deps
    );

    expect(bootstrapped).toBe(true);
    expect(calls.map((c) => c.name)).toEqual(['register', 'update']);

    expect(calls[0]?.args).toEqual(['a1', '-1001', 'DevilRATiBot', undefined, 'My Group']);
    expect(calls[1]?.args).toEqual(['a1', '-1001', undefined, 'My Group']);
  });

  it('does not bootstrap for private chats', async () => {
    const { maybeBootstrapHomeChannelFromGroupEngagement } = (await modPromise);

    const bootstrapped = await maybeBootstrapHomeChannelFromGroupEngagement(
      {
        avatarId: 'a1',
        avatarConfig: {
          platforms: {
            telegram: {
              enabled: true,
              botUsername: 'DevilRATiBot',
            },
          },
        } as unknown as import('@swarm/core').AvatarConfig,
        envelope: {
          conversationId: '123',
          metadata: {
            chatType: 'private',
            isMention: true,
          },
        },
      },
      {
        registerHomeChannelFromWebhook: async () => {
          throw new Error('should not be called');
        },
        updateAvatarHomeChannel: async () => {
          throw new Error('should not be called');
        },
        logger: {
          info: () => {},
          warn: () => {},
        },
      }
    );

    expect(bootstrapped).toBe(false);
  });

  it('does not bootstrap when already has homeChannelId', async () => {
    const { maybeBootstrapHomeChannelFromGroupEngagement } = (await modPromise);

    const bootstrapped = await maybeBootstrapHomeChannelFromGroupEngagement(
      {
        avatarId: 'a1',
        avatarConfig: {
          platforms: {
            telegram: {
              enabled: true,
              botUsername: 'DevilRATiBot',
              homeChannelId: '-9999',
            },
          },
        } as unknown as import('@swarm/core').AvatarConfig,
        envelope: {
          conversationId: '-1001',
          metadata: {
            chatType: 'group',
            isMention: true,
          },
        },
      },
      {
        registerHomeChannelFromWebhook: async () => {
          throw new Error('should not be called');
        },
        updateAvatarHomeChannel: async () => {
          throw new Error('should not be called');
        },
        logger: {
          info: () => {},
          warn: () => {},
        },
      }
    );

    expect(bootstrapped).toBe(false);
  });
});

describe('telegram-webhook-shared DM routing', () => {
  it('routes private chats to admin flow only for admin bots', async () => {
    const { shouldRoutePrivateChatToAdmin } = (await modPromise);

    expect(shouldRoutePrivateChatToAdmin(undefined)).toBe(false);
    expect(shouldRoutePrivateChatToAdmin({})).toBe(false);
    expect(shouldRoutePrivateChatToAdmin({ isAdminBot: true })).toBe(true);
    expect(shouldRoutePrivateChatToAdmin({ allowAllDms: true })).toBe(true);
  });
});
