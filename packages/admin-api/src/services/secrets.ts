/**
 * Secure Secrets Service
 * Write-only secrets management with KMS encryption
 */
import {
  SecretsManagerClient,
  CreateSecretCommand,
  UpdateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { SecretMetadata, SecretType, UserSession } from '../types.js';

const secretsClient = new SecretsManagerClient({});
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const SECRETS_TABLE = process.env.ADMIN_TABLE!;
const KMS_KEY_ID = process.env.KMS_KEY_ID!;
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'swarm';

/**
 * Generate a unique secret ARN/name
 */
function generateSecretName(avatarId: string | null, secretType: SecretType, name: string): string {
  const sanitizedName = name.replace(/[^a-zA-Z0-9-_]/g, '-');
  if (avatarId) {
    return `${SECRET_PREFIX}/${avatarId}/${secretType}/${sanitizedName}`;
  }
  return `${SECRET_PREFIX}/global/${secretType}/${sanitizedName}`;
}

/**
 * Store a secret securely
 * - Creates/updates in Secrets Manager with KMS encryption
 * - Stores metadata in DynamoDB (NO secret values)
 * - Returns only the metadata
 */
export async function storeSecret(
  avatarId: string | null,
  secretType: SecretType,
  name: string,
  value: string,
  session: UserSession,
  description?: string
): Promise<SecretMetadata> {
  const secretName = generateSecretName(avatarId, secretType, name);
  const now = Date.now();

  // Check if secret already exists
  let secretArn: string;
  let isNew = false;

  try {
    const existing = await secretsClient.send(new DescribeSecretCommand({
      SecretId: secretName,
    }));
    secretArn = existing.ARN!;
    
    // Update existing secret
    await secretsClient.send(new UpdateSecretCommand({
      SecretId: secretName,
      SecretString: value,
    }));
  } catch (error: unknown) {
    if ((error as { name?: string }).name === 'ResourceNotFoundException') {
      // Create new secret
      isNew = true;
      const result = await secretsClient.send(new CreateSecretCommand({
        Name: secretName,
        SecretString: value,
        KmsKeyId: KMS_KEY_ID,
        Description: description,
        Tags: [
          { Key: 'swarm:avatar', Value: avatarId || 'global' },
          { Key: 'swarm:type', Value: secretType },
          { Key: 'swarm:managed', Value: 'true' },
        ],
      }));
      secretArn = result.ARN!;
    } else {
      throw error;
    }
  }

  // Store metadata in DynamoDB
  const metadata: SecretMetadata = {
    pk: avatarId ? `AVATAR#${avatarId}` : 'GLOBAL',
    sk: `SECRET#${secretType}#${name}`,
    secretType,
    name,
    description,
    secretArn,
    createdAt: isNew ? now : 0, // Will be preserved on update
    createdBy: isNew ? session.email : '',
    updatedAt: now,
    updatedBy: session.email,
    isGlobal: !avatarId,
  };

  // Get existing metadata to preserve createdAt/createdBy
  if (!isNew) {
    const existing = await dynamoClient.send(new GetCommand({
      TableName: SECRETS_TABLE,
      Key: { pk: metadata.pk, sk: metadata.sk },
    }));
    if (existing.Item) {
      metadata.createdAt = existing.Item.createdAt;
      metadata.createdBy = existing.Item.createdBy;
    }
  }

  await dynamoClient.send(new PutCommand({
    TableName: SECRETS_TABLE,
    Item: metadata,
  }));

  return metadata;
}

/**
 * Store platform secrets (convenience wrapper)
 */
export async function storeTelegramSecrets(
  avatarId: string,
  botToken: string,
  session: UserSession
): Promise<SecretMetadata> {
  return storeSecret(
    avatarId,
    'telegram_bot_token',
    'bot-token',
    botToken,
    session,
    `Telegram bot token for ${avatarId}`
  );
}

export async function storeTwitterSecrets(
  avatarId: string,
  secrets: {
    apiKey: string;
    apiSecret: string;
    accessToken: string;
    accessSecret: string;
    bearerToken?: string;
  },
  session: UserSession
): Promise<SecretMetadata[]> {
  const results: SecretMetadata[] = [];

  results.push(await storeSecret(avatarId, 'twitter_api_key', 'api-key', secrets.apiKey, session));
  results.push(await storeSecret(avatarId, 'twitter_api_secret', 'api-secret', secrets.apiSecret, session));
  results.push(await storeSecret(avatarId, 'twitter_access_token', 'access-token', secrets.accessToken, session));
  results.push(await storeSecret(avatarId, 'twitter_access_secret', 'access-secret', secrets.accessSecret, session));
  
  if (secrets.bearerToken) {
    results.push(await storeSecret(avatarId, 'twitter_bearer_token', 'bearer-token', secrets.bearerToken, session));
  }

  return results;
}

export async function storeDiscordSecrets(
  avatarId: string,
  secrets: {
    botToken: string;
    clientId?: string;
    clientSecret?: string;
  },
  session: UserSession
): Promise<SecretMetadata[]> {
  const results: SecretMetadata[] = [];

  results.push(await storeSecret(avatarId, 'discord_bot_token', 'bot-token', secrets.botToken, session));
  
  if (secrets.clientId) {
    results.push(await storeSecret(avatarId, 'discord_client_id', 'client-id', secrets.clientId, session));
  }
  if (secrets.clientSecret) {
    results.push(await storeSecret(avatarId, 'discord_client_secret', 'client-secret', secrets.clientSecret, session));
  }

  return results;
}

/**
 * Store AI provider API key (global or per-avatar)
 */
export async function storeAIProviderKey(
  provider: 'openrouter' | 'anthropic' | 'openai' | 'replicate',
  apiKey: string,
  session: UserSession,
  avatarId?: string
): Promise<SecretMetadata> {
  const secretType = `${provider}_api_key` as SecretType;
  return storeSecret(
    avatarId || null,
    secretType,
    'api-key',
    apiKey,
    session,
    `${provider} API key${avatarId ? ` for ${avatarId}` : ' (global)'}`
  );
}

/**
 * List secrets (metadata only, NOT values)
 */
export async function listSecrets(
  avatarId?: string
): Promise<SecretMetadata[]> {
  const results: SecretMetadata[] = [];

  if (avatarId) {
    // List secrets for specific avatar
    const avatarecrets = await dynamoClient.send(new QueryCommand({
      TableName: SECRETS_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: {
        ':pk': `AVATAR#${avatarId}`,
        ':sk': 'SECRET#',
      },
    }));
    results.push(...(avatarecrets.Items as SecretMetadata[] || []));
  } else {
    // List all secrets (global + all avatars)
    const globalSecrets = await dynamoClient.send(new QueryCommand({
      TableName: SECRETS_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: {
        ':pk': 'GLOBAL',
        ':sk': 'SECRET#',
      },
    }));
    results.push(...(globalSecrets.Items as SecretMetadata[] || []));

    // Query for all avatar secrets would require a scan or GSI
    // For now, return global only when no avatarId specified
  }

  return results;
}

/**
 * Delete a secret
 */
export async function deleteSecret(
  avatarId: string | null,
  secretType: SecretType,
  name: string,
  _session: UserSession
): Promise<void> {
  const pk = avatarId ? `AVATAR#${avatarId}` : 'GLOBAL';
  const sk = `SECRET#${secretType}#${name}`;

  // Get the metadata to find the ARN
  const existing = await dynamoClient.send(new GetCommand({
    TableName: SECRETS_TABLE,
    Key: { pk, sk },
  }));

  if (!existing.Item) {
    throw new Error('Secret not found');
  }

  const metadata = existing.Item as SecretMetadata;

  // Delete from Secrets Manager
  await secretsClient.send(new DeleteSecretCommand({
    SecretId: metadata.secretArn,
    ForceDeleteWithoutRecovery: false, // Allow recovery for 7 days
  }));

  // Delete metadata from DynamoDB
  await dynamoClient.send(new DeleteCommand({
    TableName: SECRETS_TABLE,
    Key: { pk, sk },
  }));
}

/**
 * Check if a secret exists
 */
export async function secretExists(
  avatarId: string | null,
  secretType: SecretType,
  name: string
): Promise<boolean> {
  const pk = avatarId ? `AVATAR#${avatarId}` : 'GLOBAL';
  const sk = `SECRET#${secretType}#${name}`;

  const result = await dynamoClient.send(new GetCommand({
    TableName: SECRETS_TABLE,
    Key: { pk, sk },
  }));

  return !!result.Item;
}

/**
 * Get secret ARN (for Lambda environment variables)
 * Does NOT return the secret value
 */
export async function getSecretArn(
  avatarId: string | null,
  secretType: SecretType,
  name: string
): Promise<string | null> {
  const pk = avatarId ? `AVATAR#${avatarId}` : 'GLOBAL';
  const sk = `SECRET#${secretType}#${name}`;

  const result = await dynamoClient.send(new GetCommand({
    TableName: SECRETS_TABLE,
    Key: { pk, sk },
  }));

  return (result.Item as SecretMetadata)?.secretArn || null;
}

async function getLatestSecretArnForType(
  avatarId: string,
  secretType: SecretType
): Promise<string | null> {
  const pk = avatarId ? `AVATAR#${avatarId}` : 'GLOBAL';
  const result = await dynamoClient.send(new QueryCommand({
    TableName: SECRETS_TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': pk,
      ':skPrefix': `SECRET#${secretType}#`,
    },
  }));

  const items = (result.Items || []) as SecretMetadata[];
  if (items.length === 0) return null;

  items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return items[0]?.secretArn || null;
}

/**
 * Get secret value - INTERNAL USE ONLY
 *
 * WARNING: This function breaks the "write-only" security model.
 * Only use for legitimate internal operations like:
 * - Avatar retrieving its own Helius API key for RPC calls
 * - Avatar retrieving its own wallet private key for signing
 *
 * NEVER expose this through the admin API or chat tools.
 * NEVER use to retrieve secrets for display or export.
 *
 * @internal
 */
export async function _getSecretValueInternal(
  avatarId: string,
  secretType: SecretType,
  name: string
): Promise<string | null> {
  // Log access for audit purposes
  console.warn(`[AUDIT] Secret value accessed: avatar=${avatarId}, type=${secretType}, name=${name}`);

  let secretArn = await getSecretArn(avatarId, secretType, name);
  if (!secretArn && name === 'default') {
    secretArn = await getLatestSecretArnForType(avatarId, secretType);
  }
  if (!secretArn) return null;

  try {
    const response = await secretsClient.send(new GetSecretValueCommand({
      SecretId: secretArn,
    }));
    return response.SecretString || null;
  } catch (error) {
    console.error('Error retrieving secret:', error);
    return null;
  }
}

/**
 * @deprecated Use _getSecretValueInternal instead - renamed to make internal-only usage clear
 */
export const getSecretValue = _getSecretValueInternal;
