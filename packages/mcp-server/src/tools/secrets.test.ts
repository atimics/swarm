/**
 * Secrets Tools Tests
 *
 * Tests for secrets management tools.
 */
import { describe, it, expect } from 'vitest';
import { createSecretTools, type SecretServices } from './secrets.js';

const mockSecretServices: SecretServices = {
  listSecrets: async (avatarId: string) => {
    if (avatarId === 'empty') return [];
    return [
      {
        secretType: 'telegram_bot_token',
        name: 'Telegram Bot',
        description: 'Main bot token',
        lastUpdated: Date.now(),
      },
      {
        secretType: 'openai_api_key',
        name: 'OpenAI Key',
        lastUpdated: Date.now(),
      },
    ];
  },

  storeSecret: async () => {
    // Mock successful storage
  },

  validateTelegramToken: async (token: string) => {
    if (token === 'valid-token') {
      return { valid: true, botInfo: { username: 'test_bot' } };
    }
    return { valid: false, error: 'Invalid token format' };
  },
};

describe('Secrets Tools - get_my_secrets', () => {
  it('lists stored secrets without revealing values', async () => {
    const tools = createSecretTools(mockSecretServices);
    const tool = tools.find(t => t.name === 'get_my_secrets');
    expect(tool).toBeDefined();

    const result = await (tool!.execute as any)({}, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(true);
    expect(result.data).toBeInstanceOf(Array);
    expect(result.data.length).toBe(2);
    expect(result.data[0]).toHaveProperty('type', 'telegram_bot_token');
    expect(result.data[0]).toHaveProperty('configured', true);
    expect(result.data[0]).not.toHaveProperty('value');
  });

  it('returns empty array when no secrets exist', async () => {
    const tools = createSecretTools(mockSecretServices);
    const tool = tools.find(t => t.name === 'get_my_secrets');

    const result = await (tool!.execute as any)({}, {
      avatarId: 'empty',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it('is only available on admin-ui and api platforms', () => {
    const tools = createSecretTools(mockSecretServices);
    const tool = tools.find(t => t.name === 'get_my_secrets');

    expect(tool?.platforms).toEqual(['admin-ui', 'api']);
  });

  it('has secrets category', () => {
    const tools = createSecretTools(mockSecretServices);
    const tool = tools.find(t => t.name === 'get_my_secrets');

    expect(tool?.category).toBe('secrets');
  });
});

describe('Secrets Tools - store_secret', () => {
  it('stores a secret with valid input', async () => {
    const tools = createSecretTools(mockSecretServices);
    const tool = tools.find(t => t.name === 'store_secret');
    expect(tool).toBeDefined();

    const result = await (tool!.execute as any)(
      {
        secretType: 'openai_api_key',
        name: 'My OpenAI Key',
        value: 'sk-test123',
      },
      { avatarId: 'test', platform: 'admin-ui' }
    );

    expect(result.success).toBe(true);
  });

  it('validates Telegram bot tokens', async () => {
    const tools = createSecretTools(mockSecretServices);
    const tool = tools.find(t => t.name === 'store_secret');

    const validResult = await (tool!.execute as any)(
      {
        secretType: 'telegram_bot_token',
        name: 'Bot Token',
        value: 'valid-token',
      },
      { avatarId: 'test', platform: 'admin-ui' }
    );

    const invalidResult = await (tool!.execute as any)(
      {
        secretType: 'telegram_bot_token',
        name: 'Bot Token',
        value: 'invalid-token',
      },
      { avatarId: 'test', platform: 'admin-ui' }
    );

    expect(validResult.success).toBe(true);
    expect(invalidResult.success).toBe(false);
    expect(invalidResult.error).toContain('Invalid');
  });

  it('validates required fields', () => {
    const tools = createSecretTools(mockSecretServices);
    const tool = tools.find(t => t.name === 'store_secret');

    const valid = tool!.inputSchema.safeParse({
      secretType: 'openai_api_key',
      name: 'Key',
      value: 'secret',
    });
    const missingValue = tool!.inputSchema.safeParse({
      secretType: 'openai_api_key',
      name: 'Key',
    });

    expect(valid.success).toBe(true);
    expect(missingValue.success).toBe(false);
  });

  it('validates secretType enum values', () => {
    const tools = createSecretTools(mockSecretServices);
    const tool = tools.find(t => t.name === 'store_secret');

    const valid = tool!.inputSchema.safeParse({
      secretType: 'telegram_bot_token',
      name: 'Token',
      value: 'secret',
    });
    const invalid = tool!.inputSchema.safeParse({
      secretType: 'unknown_type',
      name: 'Token',
      value: 'secret',
    });

    expect(valid.success).toBe(true);
    expect(invalid.success).toBe(false);
  });

  it('accepts optional description', () => {
    const tools = createSecretTools(mockSecretServices);
    const tool = tools.find(t => t.name === 'store_secret');

    const withDescription = tool!.inputSchema.safeParse({
      secretType: 'openai_api_key',
      name: 'Key',
      value: 'secret',
      description: 'Production key',
    });

    expect(withDescription.success).toBe(true);
  });

  it('is only available on admin-ui and api platforms', () => {
    const tools = createSecretTools(mockSecretServices);
    const tool = tools.find(t => t.name === 'store_secret');

    expect(tool?.platforms).toEqual(['admin-ui', 'api']);
  });

  it('has secrets category', () => {
    const tools = createSecretTools(mockSecretServices);
    const tool = tools.find(t => t.name === 'store_secret');

    expect(tool?.category).toBe('secrets');
  });
});

describe('Secrets Tools - Service Interface', () => {
  it('creates tools with valid service interface', () => {
    const tools = createSecretTools(mockSecretServices);

    expect(tools.length).toBeGreaterThan(0);
    tools.forEach(tool => {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    });
  });

  it('secret management tools have secrets category', () => {
    const tools = createSecretTools(mockSecretServices);
    const secretTools = tools.filter(t => t.category === 'secrets');

    // There should be at least one secrets tool
    expect(secretTools.length).toBeGreaterThan(0);
  });

  it('secret tools never expose values', async () => {
    const tools = createSecretTools(mockSecretServices);
    const getTool = tools.find(t => t.name === 'get_my_secrets');

    const result = await (getTool!.execute as any)({}, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(true);
    result.data.forEach((secret: any) => {
      expect(secret).not.toHaveProperty('value');
      expect(secret).not.toHaveProperty('secretValue');
    });
  });
});

describe('Secrets Tools - Security', () => {
  it('never returns secret values in responses', async () => {
    const tools = createSecretTools(mockSecretServices);
    const getTool = tools.find(t => t.name === 'get_my_secrets');

    const result = await (getTool!.execute as any)({}, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('sk-');
    expect(serialized).not.toContain('token:');
  });

  it('validates input before storing secrets', () => {
    const tools = createSecretTools(mockSecretServices);
    const tool = tools.find(t => t.name === 'store_secret');

    // Missing required field should fail validation
    const validation = tool!.inputSchema.safeParse({
      secretType: 'openai_api_key',
    });

    expect(validation.success).toBe(false);
  });
});
