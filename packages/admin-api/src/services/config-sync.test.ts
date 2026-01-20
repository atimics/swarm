import { describe, it, expect } from 'bun:test';
import type { AvatarRecord } from '../types.js';
import { convertToAvatarConfig } from './config-sync.js';

describe('config-sync convertToAvatarConfig', () => {
  it('includes Telegram allowedChatIds and allowedDmUserIds when present', () => {
    const record = {
      pk: 'AVATAR#test-avatar',
      sk: 'CONFIG',
      avatarId: 'test-avatar',
      name: 'Test Avatar',
      platforms: {
        telegram: {
          enabled: true,
          botUsername: 'testbot',
          allowedChatIds: ['-1001', '-1002'],
          allowedDmUserIds: ['111', '222'],
        },
      },
      voiceConfig: {
        enabled: true,
        ttsProvider: 'voice-clone',
        format: 'ogg',
      },
      llmConfig: {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        temperature: 0.8,
        maxTokens: 1024,
        useGlobalKey: true,
      },
      currentEra: 0,
      status: 'active',
      createdAt: Date.now(),
      createdBy: 'test@example.com',
      updatedAt: Date.now(),
      updatedBy: 'test@example.com',
    } satisfies Partial<AvatarRecord> as AvatarRecord;

    const config = convertToAvatarConfig(record);

    expect(config.platforms.telegram?.enabled).toBe(true);
    expect(config.platforms.telegram?.allowedChatIds).toEqual(['-1001', '-1002']);
    expect(config.platforms.telegram?.allowedDmUserIds).toEqual(['111', '222']);
  });

  it('does not require Telegram allowlists to be set', () => {
    const record = {
      pk: 'AVATAR#test-avatar',
      sk: 'CONFIG',
      avatarId: 'test-avatar',
      name: 'Test Avatar',
      platforms: {
        telegram: {
          enabled: true,
          botUsername: 'testbot',
        },
      },
      voiceConfig: {
        enabled: true,
        ttsProvider: 'voice-clone',
        format: 'ogg',
      },
      llmConfig: {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        temperature: 0.8,
        maxTokens: 1024,
        useGlobalKey: true,
      },
      currentEra: 0,
      status: 'active',
      createdAt: Date.now(),
      createdBy: 'test@example.com',
      updatedAt: Date.now(),
      updatedBy: 'test@example.com',
    } satisfies Partial<AvatarRecord> as AvatarRecord;

    const config = convertToAvatarConfig(record);

    expect(config.platforms.telegram?.enabled).toBe(true);
    expect(config.platforms.telegram?.allowedChatIds).toBeUndefined();
    expect(config.platforms.telegram?.allowedDmUserIds).toBeUndefined();
  });
});
