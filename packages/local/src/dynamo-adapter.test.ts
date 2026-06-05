/**
 * LocalDynamoClientAdapter tests — verifies the adapter correctly
 * routes DynamoDB command objects through KeyValueStore.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { SqliteRepository } from './sqlite-repository.js';
import { LocalDynamoClientAdapter } from './dynamo-adapter.js';

// Mimic AWS SDK command constructors
class GetCommand {
  constructor(public input: { TableName: string; Key: { pk: string; sk: string }; ProjectionExpression?: string }) {}
}
class PutCommand {
  constructor(public input: { TableName: string; Item: Record<string, unknown>; ConditionExpression?: string; ReturnValues?: string }) {}
}
class QueryCommand {
  constructor(public input: { TableName: string; KeyConditionExpression: string; ExpressionAttributeValues: Record<string, unknown>; Limit?: number }) {}
}
class DeleteCommand {
  constructor(public input: { TableName: string; Key: { pk: string; sk: string } }) {}
}
class UpdateCommand {
  constructor(public input: { TableName: string; Key: { pk: string; sk: string }; UpdateExpression: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown>; ReturnValues?: string }) {}
}
class ScanCommand {
  constructor(public input: { TableName: string; FilterExpression: string; ExpressionAttributeValues: Record<string, unknown> }) {}
}
class BatchWriteCommand {
  constructor(public input: { RequestItems: Record<string, Array<{ PutRequest?: { Item: Record<string, unknown> }; DeleteRequest?: { Key: { pk: string; sk: string } } }>> }) {}
}
class TransactWriteCommand {
  constructor(public input: { TransactItems: Array<{ Put?: { TableName: string; Item: Record<string, unknown> }; Delete?: { TableName: string; Key: { pk: string; sk: string } } }> }) {}
}

describe('LocalDynamoClientAdapter', () => {
  let adapter: LocalDynamoClientAdapter;
  let store: SqliteRepository;

  beforeEach(() => {
    store = new SqliteRepository({ dbPath: ':memory:', tableName: 'adapter_test' });
    adapter = new LocalDynamoClientAdapter(store);
  });

  it('handles GetCommand', async () => {
    await store.put({ pk: 'U#1', sk: 'META', name: 'Alice' });

    const cmd = new GetCommand({
      TableName: 'test',
      Key: { pk: 'U#1', sk: 'META' },
    });
    const result = await adapter.send(cmd as any) as { Item?: Record<string, unknown> };
    expect(result.Item).toBeDefined();
    expect(result.Item!.name).toBe('Alice');
    expect(result.$metadata.httpStatusCode).toBe(200);
  });

  it('returns undefined Item for missing key', async () => {
    const cmd = new GetCommand({
      TableName: 'test',
      Key: { pk: 'NOPE', sk: 'NOPE' },
    });
    const result = await adapter.send(cmd as any) as { Item?: Record<string, unknown> };
    expect(result.Item).toBeUndefined();
  });

  it('handles PutCommand', async () => {
    const cmd = new PutCommand({
      TableName: 'test',
      Item: { pk: 'U#1', sk: 'META', name: 'Bob' },
    });
    const result = await adapter.send(cmd as any) as { $metadata: { httpStatusCode: number } };
    expect(result.$metadata.httpStatusCode).toBe(200);

    const item = await store.get({ pk: 'U#1', sk: 'META' });
    expect(item!.name).toBe('Bob');
  });

  it('handles PutCommand with ALL_NEW ReturnValues', async () => {
    await store.put({ pk: 'U#1', sk: 'META', name: 'Old' });

    const cmd = new PutCommand({
      TableName: 'test',
      Item: { pk: 'U#1', sk: 'META', name: 'New' },
      ReturnValues: 'ALL_NEW',
    });
    const result = await adapter.send(cmd as any) as { Attributes?: Record<string, unknown> };
    expect(result.Attributes!.name).toBe('New');
  });

  it('handles QueryCommand', async () => {
    await store.put({ pk: 'AVATAR#a1', sk: 'CH#telegram#1' });
    await store.put({ pk: 'AVATAR#a1', sk: 'CH#discord#1' });

    const cmd = new QueryCommand({
      TableName: 'test',
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: { ':pk': 'AVATAR#a1', ':sk': 'CH#' },
    });
    const result = await adapter.send(cmd as any) as { Items?: Record<string, unknown>[]; Count?: number };
    expect(result.Items).toHaveLength(2);
    expect(result.Count).toBe(2);
  });

  it('handles QueryCommand with exact sk match', async () => {
    await store.put({ pk: 'PK#1', sk: 'A' });
    await store.put({ pk: 'PK#1', sk: 'B' });

    const cmd = new QueryCommand({
      TableName: 'test',
      KeyConditionExpression: 'pk = :pk AND sk = :sk',
      ExpressionAttributeValues: { ':pk': 'PK#1', ':sk': 'A' },
    });
    const result = await adapter.send(cmd as any) as { Items?: Record<string, unknown>[] };
    expect(result.Items).toHaveLength(1);
    expect(result.Items![0].sk).toBe('A');
  });

  it('handles DeleteCommand', async () => {
    await store.put({ pk: 'U#1', sk: 'META' });

    const cmd = new DeleteCommand({
      TableName: 'test',
      Key: { pk: 'U#1', sk: 'META' },
    });
    await adapter.send(cmd as any);

    const item = await store.get({ pk: 'U#1', sk: 'META' });
    expect(item).toBeNull();
  });

  it('handles UpdateCommand', async () => {
    await store.put({ pk: 'U#1', sk: 'META', count: 0 });

    const cmd = new UpdateCommand({
      TableName: 'test',
      Key: { pk: 'U#1', sk: 'META' },
      UpdateExpression: 'SET #c = if_not_exists(#c, :zero) + :inc',
      ExpressionAttributeNames: { '#c': 'count' },
      ExpressionAttributeValues: { ':zero': 0, ':inc': 5 },
    });
    await adapter.send(cmd as any);

    const item = await store.get<Record<string, unknown>>({ pk: 'U#1', sk: 'META' });
    expect(item!.count).toBe(5);
  });

  it('handles UpdateCommand with ALL_NEW return', async () => {
    await store.put({ pk: 'U#1', sk: 'META', name: 'Old' });

    const cmd = new UpdateCommand({
      TableName: 'test',
      Key: { pk: 'U#1', sk: 'META' },
      UpdateExpression: 'SET #n = :name',
      ExpressionAttributeNames: { '#n': 'name' },
      ExpressionAttributeValues: { ':name': 'Updated' },
      ReturnValues: 'ALL_NEW',
    });
    const result = await adapter.send(cmd as any) as { Attributes?: Record<string, unknown> };
    expect(result.Attributes!.name).toBe('Updated');
  });

  it('handles ScanCommand with filter', async () => {
    await store.put({ pk: 'S#1', sk: 'A', type: 'image' });
    await store.put({ pk: 'S#1', sk: 'B', type: 'video' });

    const cmd = new ScanCommand({
      TableName: 'test',
      FilterExpression: '#type = :type',
      ExpressionAttributeValues: { ':type': 'image' },
      ExpressionAttributeNames: { '#type': 'type' },
    });
    const result = await adapter.send(cmd as any) as { Items?: Record<string, unknown>[] };
    expect(result.Items).toHaveLength(1);
    expect(result.Items![0].type).toBe('image');
  });

  it('handles BatchWriteCommand', async () => {
    const cmd = new BatchWriteCommand({
      RequestItems: {
        test: [
          { PutRequest: { Item: { pk: 'B#1', sk: 'A', val: 1 } } },
          { PutRequest: { Item: { pk: 'B#1', sk: 'B', val: 2 } } },
        ],
      },
    });
    await adapter.send(cmd as any);

    const items = await store.query('B#1');
    expect(items).toHaveLength(2);
  });

  it('handles BatchWriteCommand with mixed put/delete', async () => {
    await store.put({ pk: 'B#1', sk: 'A' });
    await store.put({ pk: 'B#1', sk: 'B' });

    const cmd = new BatchWriteCommand({
      RequestItems: {
        test: [
          { PutRequest: { Item: { pk: 'B#1', sk: 'C', val: 3 } } },
          { DeleteRequest: { Key: { pk: 'B#1', sk: 'A' } } },
        ],
      },
    });
    await adapter.send(cmd as any);

    const items = await store.query('B#1');
    const sks = items.map((i: any) => i.sk).sort();
    expect(sks).toEqual(['B', 'C']);
  });

  it('handles TransactWriteCommand', async () => {
    const cmd = new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: 'test', Item: { pk: 'T#1', sk: 'A', val: 1 } } },
        { Put: { TableName: 'test', Item: { pk: 'T#1', sk: 'B', val: 2 } } },
      ],
    });
    const result = await adapter.send(cmd as any) as { $metadata: { httpStatusCode: number } };
    expect(result.$metadata.httpStatusCode).toBe(200);

    const items = await store.query('T#1');
    expect(items).toHaveLength(2);
  });

  it('throws on unsupported command', async () => {
    class UnknownCommand {
      constructor(public input: unknown) {}
    }
    const cmd = new UnknownCommand({});
    await expect(adapter.send(cmd as any)).rejects.toThrow('unsupported');
  });
});
