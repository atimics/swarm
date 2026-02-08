import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createHash, randomBytes } from 'crypto';
import { getDynamoClient } from './services/dynamo-client.js';

const ADMIN_TABLE = process.env.ADMIN_TABLE || 'SwarmAdmin-prod';

const docClient = getDynamoClient();

function generateApiKey() {
  const keyBytes = randomBytes(32);
  const fullKey = `sk-swarm-${keyBytes.toString('base64url')}`;
  const keyHash = createHash('sha256').update(fullKey).digest('hex');
  const keyPrefix = fullKey.slice(0, 12);
  return { fullKey, keyHash, keyPrefix };
}

async function main() {
  const { fullKey, keyHash, keyPrefix } = generateApiKey();
  
  // Store the API key record with wildcard avatarId
  await docClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `API_KEY#${keyHash}`,
      sk: 'META',
    },
    UpdateExpression: `
      SET keyPrefix = :keyPrefix,
          keyHash = :keyHash,
          avatarId = :avatarId,
          #name = :name,
          createdAt = :createdAt,
          createdBy = :createdBy,
          usageCount = :usageCount,
          enabled = :enabled
    `,
    ExpressionAttributeNames: {
      '#name': 'name',
    },
    ExpressionAttributeValues: {
      ':keyPrefix': keyPrefix,
      ':keyHash': keyHash,
      ':avatarId': '*',
      ':name': 'VTuber Stream Master Key',
      ':createdAt': Date.now(),
      ':createdBy': 'copilot-script',
      ':usageCount': 0,
      ':enabled': true,
    },
  }));

  // Store reverse index under GLOBAL
  await docClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: 'GLOBAL',
      sk: `API_KEY#${keyHash.slice(0, 16)}`,
    },
    UpdateExpression: 'SET keyPrefix = :keyPrefix, keyHash = :keyHash, #name = :name, createdAt = :createdAt',
    ExpressionAttributeNames: {
      '#name': 'name',
    },
    ExpressionAttributeValues: {
      ':keyPrefix': keyPrefix,
      ':keyHash': keyHash,
      ':name': 'VTuber Stream Master Key',
      ':createdAt': Date.now(),
    },
  }));

  console.log('============================================================');
  console.log('WILDCARD API KEY CREATED');
  console.log('Works for ANY avatar (Opus, Chamuel, etc.)');
  console.log('============================================================');
  console.log('');
  console.log('SAVE THIS KEY - IT WILL NOT BE SHOWN AGAIN:');
  console.log('');
  console.log(fullKey);
  console.log('');
  console.log('Usage: Set model to avatar ID (e.g., "agent-1-6yan" for Opus)');
  console.log('============================================================');
}

main().catch(console.error);
