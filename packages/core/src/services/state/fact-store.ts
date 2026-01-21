import { PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { MemoryFact } from '../../types/index.js';

export async function saveFact(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  avatarId: string,
  fact: MemoryFact
): Promise<void> {
  // Create a deterministic ID from the fact content for deduplication
  // Use TextEncoder to properly handle Unicode (including emojis)
  const encoder = new TextEncoder();
  const bytes = encoder.encode(fact.fact.slice(0, 100));
  const factId = Buffer.from(bytes).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
  const sortKey = `FACT#${fact.about || 'general'}#${factId}`;

  await docClient.send(new PutCommand({
    TableName: tableName,
    Item: {
      pk: `AVATAR#${avatarId}`,
      sk: sortKey,
      fact: fact.fact,
      about: fact.about,
      userId: fact.userId,
      timestamp: fact.timestamp,
      // TTL: keep facts for 90 days
      ttl: Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60),
    },
  }));
}

export async function getFacts(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  avatarId: string,
  query: string,
  userId?: string
): Promise<MemoryFact[]> {
  // Query facts by prefix (about field)
  // For more sophisticated search, would need GSI or OpenSearch
  const result = await docClient.send(new ScanCommand({
    TableName: tableName,
    FilterExpression: 'pk = :pk AND begins_with(sk, :prefix) AND (contains(fact, :query) OR contains(about, :query))',
    ExpressionAttributeValues: {
      ':pk': `AVATAR#${avatarId}`,
      ':prefix': 'FACT#',
      ':query': query.toLowerCase(),
    },
    Limit: 20,
  }));

  const facts = (result.Items || [])
    .filter(item => {
      // If userId filter provided, only return facts from that user or general facts
      if (userId && item.userId && item.userId !== userId) {
        return false;
      }
      return true;
    })
    .map(item => ({
      fact: item.fact,
      about: item.about,
      userId: item.userId,
      timestamp: item.timestamp,
    }))
    .sort((a, b) => b.timestamp - a.timestamp);

  return facts;
}
