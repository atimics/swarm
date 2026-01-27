import type { SwarmEnvelope } from '@swarm/core';
import type { LoadedAvatarSecrets } from './load-avatar-secrets.js';

export type SecretsServiceLike = {
  getSecret: (secretId: string) => Promise<string>;
  getSecretJson: <T>(secretId: string) => Promise<T>;
};

type TwitterAppCredentialsFallback = {
  TWITTER_APP_KEY?: string;
  TWITTER_APP_SECRET?: string;
  consumer_key?: string;
  consumer_secret?: string;
  consumerKey?: string;
  consumerSecret?: string;
};

export async function loadTwitterSecretsFallback(
  secretsService: SecretsServiceLike,
  avatarId: string,
  secretPrefix: string
): Promise<LoadedAvatarSecrets> {
  const result: LoadedAvatarSecrets = {};

  const candidates = (name: string) => [
    `${secretPrefix}/${avatarId}/${name}/default`,
    `${secretPrefix}/${avatarId}/${name}`,
  ];

  for (const id of candidates('twitter_access_token')) {
    try {
      result.TWITTER_ACCESS_TOKEN = await secretsService.getSecret(id);
      break;
    } catch {
      // Try next.
    }
  }

  for (const id of candidates('twitter_access_secret')) {
    try {
      result.TWITTER_ACCESS_SECRET = await secretsService.getSecret(id);
      break;
    } catch {
      // Try next.
    }
  }

  if (!result.TWITTER_API_KEY || !result.TWITTER_API_SECRET) {
    const appCandidates = [
      `${secretPrefix}/global/twitter-app-credentials`,
      `${secretPrefix}/global/twitter-app-credentials/default`,
    ];

    for (const id of appCandidates) {
      try {
        const parsed = await secretsService.getSecretJson<TwitterAppCredentialsFallback>(id);
        const appKey = parsed.TWITTER_APP_KEY || parsed.consumer_key || parsed.consumerKey;
        const appSecret = parsed.TWITTER_APP_SECRET || parsed.consumer_secret || parsed.consumerSecret;
        if (appKey) result.TWITTER_API_KEY = result.TWITTER_API_KEY || appKey;
        if (appSecret) result.TWITTER_API_SECRET = result.TWITTER_API_SECRET || appSecret;
        if (result.TWITTER_API_KEY && result.TWITTER_API_SECRET) break;
      } catch {
        // Try next.
      }
    }
  }

  return result;
}

/**
 * Determine if a mention should be processed and replied to.
 *
 * Only reply to:
 * 1. Direct replies to bot's tweets (highest priority)
 * 2. Explicit @mentions in tweet text (not just part of a thread)
 */
export function shouldProcessMention(
  mention: Pick<SwarmEnvelope, 'sender' | 'raw' | 'content'>,
  botUserId: string,
  botUsername?: string
): boolean {
  if (mention.sender.id === botUserId) {
    return false;
  }

  const raw = mention.raw as { in_reply_to_user_id?: string };
  if (raw.in_reply_to_user_id === botUserId) {
    return true;
  }

  if (botUsername) {
    const text = mention.content.text?.toLowerCase() || '';
    return text.includes(`@${botUsername.toLowerCase()}`);
  }

  return false;
}
