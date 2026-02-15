import { describe, it, expect } from 'vitest';
import type { SecretsService } from '@swarm/core';
import { ensureReplicateKey, getSystemReplicateKey } from './system-replicate-key.js';

describe('system-replicate-key', () => {
  it('prefers direct env var token', async () => {
    const prev = {
      REPLICATE_API_TOKEN: process.env.REPLICATE_API_TOKEN,
      REPLICATE_API_KEY: process.env.REPLICATE_API_KEY,
      REPLICATE_API_KEY_SECRET_ARN: process.env.REPLICATE_API_KEY_SECRET_ARN,
    };

    process.env.REPLICATE_API_TOKEN = 'env-token';
    delete process.env.REPLICATE_API_KEY;
    delete process.env.REPLICATE_API_KEY_SECRET_ARN;

    const secretsService: SecretsService = {
      getSecret: async () => {
        throw new Error('should not be called');
      },
      getSecretJson: async () => {
        throw new Error('not used');
      },
      getAvatarSecrets: async () => ({}),
    };

    const key = await getSystemReplicateKey(secretsService);
    expect(key).toBe('env-token');

    process.env.REPLICATE_API_TOKEN = prev.REPLICATE_API_TOKEN;
    process.env.REPLICATE_API_KEY = prev.REPLICATE_API_KEY;
    process.env.REPLICATE_API_KEY_SECRET_ARN = prev.REPLICATE_API_KEY_SECRET_ARN;
  });

  it('loads from Secrets Manager ARN (raw string)', async () => {
    const prev = {
      REPLICATE_API_TOKEN: process.env.REPLICATE_API_TOKEN,
      REPLICATE_API_KEY: process.env.REPLICATE_API_KEY,
      REPLICATE_API_KEY_SECRET_ARN: process.env.REPLICATE_API_KEY_SECRET_ARN,
    };

    delete process.env.REPLICATE_API_TOKEN;
    delete process.env.REPLICATE_API_KEY;
    process.env.REPLICATE_API_KEY_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:replicate';

    const secretsService: SecretsService = {
      getSecret: async () => 'secret-token',
      getSecretJson: async () => {
        throw new Error('not used');
      },
      getAvatarSecrets: async () => ({}),
    };

    const key = await getSystemReplicateKey(secretsService);
    expect(key).toBe('secret-token');

    process.env.REPLICATE_API_TOKEN = prev.REPLICATE_API_TOKEN;
    process.env.REPLICATE_API_KEY = prev.REPLICATE_API_KEY;
    process.env.REPLICATE_API_KEY_SECRET_ARN = prev.REPLICATE_API_KEY_SECRET_ARN;
  });

  it('parses JSON secret shapes', async () => {
    const prev = {
      REPLICATE_API_TOKEN: process.env.REPLICATE_API_TOKEN,
      REPLICATE_API_KEY: process.env.REPLICATE_API_KEY,
      REPLICATE_API_KEY_SECRET_ARN: process.env.REPLICATE_API_KEY_SECRET_ARN,
    };

    delete process.env.REPLICATE_API_TOKEN;
    delete process.env.REPLICATE_API_KEY;
    process.env.REPLICATE_API_KEY_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:replicate';

    const secretsService: SecretsService = {
      getSecret: async () => JSON.stringify({ REPLICATE_API_KEY: 'json-token' }),
      getSecretJson: async () => {
        throw new Error('not used');
      },
      getAvatarSecrets: async () => ({}),
    };

    const key = await getSystemReplicateKey(secretsService);
    expect(key).toBe('json-token');

    process.env.REPLICATE_API_TOKEN = prev.REPLICATE_API_TOKEN;
    process.env.REPLICATE_API_KEY = prev.REPLICATE_API_KEY;
    process.env.REPLICATE_API_KEY_SECRET_ARN = prev.REPLICATE_API_KEY_SECRET_ARN;
  });

  it('ensureReplicateKey injects into secrets when missing', async () => {
    const prev = {
      REPLICATE_API_TOKEN: process.env.REPLICATE_API_TOKEN,
      REPLICATE_API_KEY: process.env.REPLICATE_API_KEY,
      REPLICATE_API_KEY_SECRET_ARN: process.env.REPLICATE_API_KEY_SECRET_ARN,
    };

    delete process.env.REPLICATE_API_TOKEN;
    delete process.env.REPLICATE_API_KEY;
    process.env.REPLICATE_API_KEY_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:replicate';

    const secrets: Record<string, string> = {};
    const secretsService: SecretsService = {
      getSecret: async () => 'secret-token',
      getSecretJson: async () => {
        throw new Error('not used');
      },
      getAvatarSecrets: async () => ({}),
    };

    const ok = await ensureReplicateKey(secrets, secretsService);
    expect(ok).toBe(true);
    expect(secrets.REPLICATE_API_KEY).toBe('secret-token');

    process.env.REPLICATE_API_TOKEN = prev.REPLICATE_API_TOKEN;
    process.env.REPLICATE_API_KEY = prev.REPLICATE_API_KEY;
    process.env.REPLICATE_API_KEY_SECRET_ARN = prev.REPLICATE_API_KEY_SECRET_ARN;
  });
});
