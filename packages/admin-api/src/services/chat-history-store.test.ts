import { describe, it, expect } from 'vitest';
import { createChatHistoryStore } from './chat-history-store.js';
import type { AdminChatMessage } from '../types.js';

function makeInMemoryDynamo() {
  const store = new Map<string, Record<string, unknown>>();
  const keyOf = (pk: string, sk: string) => `${pk}|${sk}`;

  const send = async (cmd: unknown) => {
    const command = cmd as { input?: Record<string, unknown>; constructor?: { name?: string } };
    const input = command?.input ?? {};

    if (command?.constructor?.name === 'PutCommand' && (input as { Item?: Record<string, unknown> }).Item) {
      const item = (input as { Item: Record<string, unknown> }).Item;
      store.set(keyOf(item.pk as string, item.sk as string), item);
      return {};
    }

    if (command?.constructor?.name === 'GetCommand' && (input as { Key?: { pk: string; sk: string } }).Key) {
      const { pk, sk } = (input as { Key: { pk: string; sk: string } }).Key;
      return { Item: store.get(keyOf(pk, sk)) };
    }

    if (command?.constructor?.name === 'DeleteCommand' && (input as { Key?: { pk: string; sk: string } }).Key) {
      const { pk, sk } = (input as { Key: { pk: string; sk: string } }).Key;
      store.delete(keyOf(pk, sk));
      return {};
    }

    if (command?.constructor?.name === 'UpdateCommand' && (input as { Key?: { pk: string; sk: string } }).Key) {
      const { pk, sk } = (input as { Key: { pk: string; sk: string } }).Key;
      const key = keyOf(pk, sk);
      const existing = store.get(key) || {};
      const values = (input as { ExpressionAttributeValues?: Record<string, unknown> }).ExpressionAttributeValues || {};
      store.set(key, { ...existing, ttl: values[':ttl'], updatedAt: values[':updatedAt'] });
      return {};
    }

    throw new Error(`Unexpected Dynamo command: ${command?.constructor?.name}`);
  };

  return { store, send };
}

describe('chat history store', () => {
  it('refreshes ttl on read', async () => {
    let now = 1_000_000;
    const { store, send } = makeInMemoryDynamo();
    const historyStore = createChatHistoryStore({
      dynamoClient: { send } as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      tableName: 'test-table',
      ttlSeconds: 60,
      now: () => now,
    });

    const session = { email: 'test@example.com', userId: 'wallet-1', expiresAt: 0, isAdmin: false, accessToken: '' };
    const messages: AdminChatMessage[] = [{ role: 'user', content: 'hi' }];

    await historyStore.saveChatHistory(session, messages, 'avatar-1');

    now += 30_000;
    const result = await historyStore.getChatHistory(session, 'avatar-1');

    expect(result).toHaveLength(1);

    const key = 'CHAT#test@example.com|AVATAR#avatar-1';
    const record = store.get(key) as { ttl?: number };
    expect(record.ttl).toBe(Math.floor(now / 1000) + 60);
  });
});
