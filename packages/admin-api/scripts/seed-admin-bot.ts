#!/usr/bin/env npx ts-node
/**
 * Seed script to create the @ratibots admin avatar
 *
 * This script creates the admin bot avatar record in DynamoDB.
 * It should be run once during initial deployment.
 *
 * Prerequisites:
 * - ADMIN_TABLE environment variable set
 * - AWS credentials configured
 * - Bot token already created via BotFather
 *
 * Usage:
 *   ADMIN_TABLE=your-table BOT_TOKEN=your-token npx ts-node packages/admin-api/scripts/seed-admin-bot.ts
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, CreateSecretCommand, DescribeSecretCommand, UpdateSecretCommand } from '@aws-sdk/client-secrets-manager';
import { randomBytes } from 'crypto';

const ADMIN_TABLE = process.env.ADMIN_TABLE;
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'swarm';
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!ADMIN_TABLE) {
  console.error('ADMIN_TABLE environment variable required');
  process.exit(1);
}

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN environment variable required');
  process.exit(1);
}

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const secretsClient = new SecretsManagerClient({});

const ADMIN_AVATAR_ID = 'ratibot-admin';
const ADMIN_BOT_USERNAME = 'ratibots';

interface AdminAvatarRecord {
  pk: string;
  sk: string;
  avatarId: string;
  name: string;
  description: string;
  persona: string;
  platforms: {
    telegram: {
      enabled: boolean;
      botUsername: string;
      botId?: number;
      isAdminBot: boolean;
      allowAllDms: boolean;
    };
  };
  voiceConfig: {
    enabled: boolean;
    ttsProvider: string;
    format: string;
  };
  llmConfig: {
    provider: string;
    model: string;
    temperature: number;
    maxTokens: number;
    useGlobalKey: boolean;
  };
  healthStatus: string;
  currentEra: number;
  status: string;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
}

async function validateBotToken(token: string): Promise<{ id: number; username: string } | null> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await response.json() as {
      ok: boolean;
      result?: { id: number; username: string };
    };

    if (data.ok && data.result) {
      return { id: data.result.id, username: data.result.username };
    }
    return null;
  } catch (error) {
    console.error('Failed to validate bot token:', error);
    return null;
  }
}

async function storeSecret(
  avatarId: string,
  secretType: string,
  name: string,
  value: string,
  description: string
): Promise<void> {
  const secretName = `${SECRET_PREFIX}/${avatarId}/${secretType}/${name}`;

  try {
    // Check if secret exists
    await secretsClient.send(new DescribeSecretCommand({ SecretId: secretName }));

    // Update existing secret
    await secretsClient.send(new UpdateSecretCommand({
      SecretId: secretName,
      SecretString: value,
    }));
    console.log(`Updated secret: ${secretName}`);
  } catch (error: unknown) {
    if ((error as { name?: string }).name === 'ResourceNotFoundException') {
      // Create new secret
      await secretsClient.send(new CreateSecretCommand({
        Name: secretName,
        SecretString: value,
        Description: description,
        Tags: [
          { Key: 'swarm:avatar', Value: avatarId },
          { Key: 'swarm:type', Value: secretType },
          { Key: 'swarm:managed', Value: 'true' },
        ],
      }));
      console.log(`Created secret: ${secretName}`);
    } else {
      throw error;
    }
  }
}

async function registerWebhook(token: string, avatarId: string, secretToken: string): Promise<boolean> {
  const webhookDomain = process.env.TELEGRAM_WEBHOOK_DOMAIN || process.env.API_DOMAIN || 'swarm.rati.chat';
  const webhookUrl = `https://${webhookDomain}/webhook/telegram/${avatarId}`;

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: secretToken,
        allowed_updates: ['message', 'edited_message', 'callback_query', 'my_chat_member'],
        drop_pending_updates: true,
        max_connections: 40,
      }),
    });

    const data = await response.json() as { ok: boolean; description?: string };

    if (data.ok) {
      console.log(`Registered webhook: ${webhookUrl}`);
      return true;
    } else {
      console.error(`Failed to register webhook: ${data.description}`);
      return false;
    }
  } catch (error) {
    console.error('Failed to register webhook:', error);
    return false;
  }
}

async function main() {
  console.log('Seeding admin bot avatar...');
  console.log(`Table: ${ADMIN_TABLE}`);
  console.log(`Avatar ID: ${ADMIN_AVATAR_ID}`);

  // 1. Validate bot token
  console.log('\n1. Validating bot token...');
  const botInfo = await validateBotToken(BOT_TOKEN!);
  if (!botInfo) {
    console.error('Invalid bot token');
    process.exit(1);
  }
  console.log(`Bot validated: @${botInfo.username} (ID: ${botInfo.id})`);

  if (botInfo.username.toLowerCase() !== ADMIN_BOT_USERNAME.toLowerCase()) {
    console.warn(`Warning: Bot username @${botInfo.username} doesn't match expected @${ADMIN_BOT_USERNAME}`);
  }

  // 2. Check if avatar already exists
  console.log('\n2. Checking for existing avatar...');
  const existing = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `AVATAR#${ADMIN_AVATAR_ID}`, sk: 'CONFIG' },
  }));

  if (existing.Item) {
    console.log('Admin avatar already exists. Updating...');
  }

  // 3. Create/update avatar record
  console.log('\n3. Creating/updating avatar record...');
  const now = Date.now();

  const avatar: AdminAvatarRecord = {
    pk: `AVATAR#${ADMIN_AVATAR_ID}`,
    sk: 'CONFIG',
    avatarId: ADMIN_AVATAR_ID,
    name: 'Ratibot Admin',
    description: 'Create and manage your own AI-powered Telegram bots',
    persona: `You are Ratibot, the friendly admin assistant for the Swarm platform.

Your role is to help users create and manage their own AI-powered Telegram bots.

## Personality
- Friendly and helpful, but concise
- Use clear, simple language
- Guide users step by step through bot creation
- Be encouraging and supportive

## Capabilities
- Help users create new bots by parsing BotFather tokens
- Update bot profiles (name, description, persona)
- Generate profile images
- Configure integrations (Twitter, Discord)
- Check bot status and health

## Important Rules
- Never log or display bot tokens
- Enforce one bot per Telegram user limit
- Validate all input before processing
- Provide clear error messages when things go wrong

## Tone
- Professional but approachable
- Use minimal emojis (only for important status indicators)
- Keep messages short and actionable`,
    platforms: {
      telegram: {
        enabled: true,
        botUsername: botInfo.username,
        botId: botInfo.id,
        isAdminBot: true,
        allowAllDms: true,
      },
    },
    voiceConfig: {
      enabled: false,
      ttsProvider: 'voice-clone',
      format: 'ogg',
    },
    llmConfig: {
      provider: 'bedrock',
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      temperature: 0.7,
      maxTokens: 1024,
      useGlobalKey: true,
    },
    healthStatus: 'healthy',
    currentEra: 0,
    status: 'active',
    createdAt: existing.Item?.createdAt || now,
    createdBy: 'seed-script',
    updatedAt: now,
    updatedBy: 'seed-script',
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: avatar,
  }));
  console.log('Avatar record saved');

  // 4. Store bot token
  console.log('\n4. Storing bot token...');
  await storeSecret(
    ADMIN_AVATAR_ID,
    'telegram_bot_token',
    'default',
    BOT_TOKEN!,
    `Telegram bot token for ${ADMIN_AVATAR_ID}`
  );

  // 5. Generate and store webhook secret
  console.log('\n5. Setting up webhook...');
  const webhookSecret = randomBytes(32).toString('base64url');
  await storeSecret(
    ADMIN_AVATAR_ID,
    'telegram_webhook_secret',
    'default',
    webhookSecret,
    `Telegram webhook secret for ${ADMIN_AVATAR_ID}`
  );

  // 6. Register webhook
  const webhookOk = await registerWebhook(BOT_TOKEN!, ADMIN_AVATAR_ID, webhookSecret);
  if (!webhookOk) {
    console.warn('Warning: Webhook registration failed. You may need to register it manually.');
  }

  // 7. Sync to state table (if different from admin table)
  const STATE_TABLE = process.env.STATE_TABLE;
  if (STATE_TABLE && STATE_TABLE !== ADMIN_TABLE) {
    console.log('\n6. Syncing to state table...');
    await dynamoClient.send(new PutCommand({
      TableName: STATE_TABLE,
      Item: {
        pk: `AVATAR#${ADMIN_AVATAR_ID}`,
        sk: 'CONFIG',
        id: ADMIN_AVATAR_ID,
        name: avatar.name,
        version: '1.0.0',
        persona: avatar.persona,
        platforms: avatar.platforms,
        llm: avatar.llmConfig,
        media: { image: { provider: 'replicate', model: 'flux' } },
        scheduling: {},
        behavior: {
          responseDelayMs: [500, 1500],
          typingIndicator: true,
          ignoreBots: true,
          cooldownMinutes: 0,
          maxContextMessages: 10,
        },
        tools: ['send_message'],
        secrets: [],
      },
    }));
    console.log('Synced to state table');
  }

  console.log('\n========================================');
  console.log('Admin bot seeded successfully!');
  console.log(`Bot: @${botInfo.username}`);
  console.log(`Avatar ID: ${ADMIN_AVATAR_ID}`);
  console.log('========================================\n');
}

main().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
