import { describe, it, expect } from 'bun:test';
import { loadTwitterSecretsFallback, shouldProcessMention } from './twitter-mention-poller-logic.js';

describe('twitter-mention-poller shared logic', () => {
  describe('shouldProcessMention', () => {
    it('returns false for self-mentions', () => {
      expect(shouldProcessMention(
        {
          sender: { id: 'bot' },
          raw: {},
          content: { text: '@bot hi' },
        } as any,
        'bot',
        'bot'
      )).toBe(false);
    });

    it('returns true for replies to the bot user id', () => {
      expect(shouldProcessMention(
        {
          sender: { id: 'user-1' },
          raw: { in_reply_to_user_id: 'bot' },
          content: { text: 'hello' },
        } as any,
        'bot',
        'bot'
      )).toBe(true);
    });

    it('returns true for explicit @mention in text (case-insensitive)', () => {
      expect(shouldProcessMention(
        {
          sender: { id: 'user-1' },
          raw: {},
          content: { text: 'Hello @BoT how are you?' },
        } as any,
        'bot',
        'bot'
      )).toBe(true);
    });

    it('returns false when neither reply nor explicit mention', () => {
      expect(shouldProcessMention(
        {
          sender: { id: 'user-1' },
          raw: {},
          content: { text: 'hello world' },
        } as any,
        'bot',
        'bot'
      )).toBe(false);
    });

    it('returns false when botUsername is undefined and not a reply', () => {
      expect(shouldProcessMention(
        {
          sender: { id: 'user-1' },
          raw: {},
          content: { text: '@bot hi' },
        } as any,
        'bot'
      )).toBe(false);
    });
  });

  describe('loadTwitterSecretsFallback', () => {
    it('tries avatar secrets candidates in order and loads global app credentials', async () => {
      const calls: string[] = [];
      const secretsService = {
        getSecret: async (id: string) => {
          calls.push(`getSecret:${id}`);
          if (id.endsWith('/twitter_access_token/default')) throw new Error('not found');
          if (id.endsWith('/twitter_access_token')) return 'access-token';
          if (id.endsWith('/twitter_access_secret/default')) throw new Error('not found');
          if (id.endsWith('/twitter_access_secret')) return 'access-secret';
          throw new Error('unexpected');
        },
        getSecretJson: async (id: string) => {
          calls.push(`getSecretJson:${id}`);
          if (id.endsWith('twitter-app-credentials')) {
            return { consumer_key: 'app-key', consumer_secret: 'app-secret' };
          }
          throw new Error('unexpected');
        },
      };

      const result = await loadTwitterSecretsFallback(secretsService as any, 'avatar-1', 'swarm');

      expect(result.TWITTER_ACCESS_TOKEN).toBe('access-token');
      expect(result.TWITTER_ACCESS_SECRET).toBe('access-secret');
      expect(result.TWITTER_API_KEY).toBe('app-key');
      expect(result.TWITTER_API_SECRET).toBe('app-secret');

      expect(calls[0]).toBe('getSecret:swarm/avatar-1/twitter_access_token/default');
      expect(calls[1]).toBe('getSecret:swarm/avatar-1/twitter_access_token');
      expect(calls[2]).toBe('getSecret:swarm/avatar-1/twitter_access_secret/default');
      expect(calls[3]).toBe('getSecret:swarm/avatar-1/twitter_access_secret');
      expect(calls).toContain('getSecretJson:swarm/global/twitter-app-credentials');
    });

    it('returns access tokens even if global app credentials are missing', async () => {
      const secretsService = {
        getSecret: async (id: string) => {
          if (id.endsWith('/twitter_access_token/default')) return 'access-token';
          if (id.endsWith('/twitter_access_secret/default')) return 'access-secret';
          throw new Error('not found');
        },
        getSecretJson: async (_id: string) => {
          throw new Error('not found');
        },
      };

      const result = await loadTwitterSecretsFallback(secretsService as any, 'avatar-1', 'swarm');
      expect(result.TWITTER_ACCESS_TOKEN).toBe('access-token');
      expect(result.TWITTER_ACCESS_SECRET).toBe('access-secret');
      expect(result.TWITTER_API_KEY).toBeUndefined();
      expect(result.TWITTER_API_SECRET).toBeUndefined();
    });
  });
});
