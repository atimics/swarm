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
});
