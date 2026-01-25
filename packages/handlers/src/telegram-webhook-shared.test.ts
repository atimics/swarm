import { describe, it, expect } from 'bun:test';
import { isTelegramChatAllowed } from './telegram-webhook-shared.js';

describe('telegram-webhook-shared allowlists', () => {
  it('blocks DMs when allowedDmUserIds is missing/empty', () => {
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

  it('allows DMs only for allowlisted user IDs (string-coerced)', () => {
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

  it('allows DMs only for allowlisted users using allowedDmUsers', () => {
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

  it('treats allowedDmUsers as authoritative when present (even if empty)', () => {
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

  it('allows group chats when allowedChatIds is not configured', () => {
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

  it('allows group chats when allowedChatIds is an empty array (no enforcement)', () => {
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

  it('blocks non-private chats not present in allowedChatIds (when configured)', () => {
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
