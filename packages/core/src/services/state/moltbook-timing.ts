import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Get the timestamp of the last Moltbook heartbeat for an avatar
 */
export async function getLastMoltbookHeartbeat(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  avatarId: string
): Promise<number> {
  const result = await docClient.send(new GetCommand({
    TableName: tableName,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: 'MOLTBOOK#LAST_HEARTBEAT',
    },
  }));
  return result.Item?.timestamp || 0;
}

/**
 * Set the timestamp of the last Moltbook heartbeat for an avatar
 */
export async function setLastMoltbookHeartbeat(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  avatarId: string,
  timestamp: number
): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: tableName,
    Item: {
      pk: `AVATAR#${avatarId}`,
      sk: 'MOLTBOOK#LAST_HEARTBEAT',
      timestamp,
      updatedAt: Date.now(),
    },
  }));
}
