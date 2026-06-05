/**
 * LocalDynamoClientAdapter — routes DynamoDB-style send() calls through KeyValueStore.
 */
import type { KeyValueStore, CompositeKey } from '@swarm/core';

interface AwsKey { pk: string; sk: string; }

export class LocalDynamoClientAdapter {
  constructor(private store: KeyValueStore) {}

  async send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const cmdName = command.constructor?.name ?? 'Unknown';
    const input = command.input;
    switch (cmdName) {
      case 'GetCommand': return this._get(input);
      case 'PutCommand': return this._put(input);
      case 'QueryCommand': return this._query(input);
      case 'DeleteCommand': return this._del(input);
      case 'UpdateCommand': return this._update(input);
      case 'ScanCommand': return this._scan(input);
      case 'BatchWriteCommand': return this._batchWrite(input);
      case 'TransactWriteCommand':
      case 'TransactWriteItemsCommand': return this._transactWrite(input);
      default: throw new Error(`LocalDynamoClientAdapter: unsupported command "${cmdName}"`);
    }
  }

  private async _get(input: Record<string, unknown>) {
    const key = input.Key as CompositeKey;
    const item = await this.store.get<Record<string, unknown>>(key, {
      projectionExpression: input.ProjectionExpression as string | undefined,
      expressionAttributeNames: input.ExpressionAttributeNames as Record<string, string> | undefined,
    });
    return { Item: item ?? undefined, $metadata: { httpStatusCode: 200 } };
  }

  private async _put(input: Record<string, unknown>) {
    const item = input.Item as Record<string, unknown> & CompositeKey;
    const { pk, sk, ...rest } = item;
    const hasCond = input.ConditionExpression || input.ExpressionAttributeNames;
    let oldItem: Record<string, unknown> | null = null;
    const rv = input.ReturnValues as string | undefined;
    if (rv === 'ALL_OLD' || rv === 'UPDATED_OLD') {
      oldItem = await this.store.get<Record<string, unknown>>({ pk, sk });
    }
    await this.store.put({ pk, sk, ...rest }, hasCond ? {
      conditionExpression: input.ConditionExpression as string | undefined,
      expressionAttributeNames: input.ExpressionAttributeNames as Record<string, string> | undefined,
      expressionAttributeValues: input.ExpressionAttributeValues as Record<string, unknown> | undefined,
    } : undefined);
    let newItem: Record<string, unknown> | null = null;
    if (rv === 'ALL_NEW' || rv === 'UPDATED_NEW') {
      newItem = await this.store.get<Record<string, unknown>>({ pk, sk });
    }
    const resp: Record<string, unknown> = { $metadata: { httpStatusCode: 200 } };
    if (rv === 'ALL_OLD' || rv === 'UPDATED_OLD') resp.Attributes = oldItem ?? undefined;
    else if (rv === 'ALL_NEW' || rv === 'UPDATED_NEW') resp.Attributes = newItem ?? undefined;
    return resp;
  }

  private async _query(input: Record<string, unknown>) {
    const expr = input.KeyConditionExpression as string;
    const vals = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
    const pkMatch = expr.match(/pk\s*=\s*(:\w+)/);
    if (!pkMatch) throw new Error(`Unsupported KeyConditionExpression: "${expr}"`);
    const pk: string = vals[pkMatch[1]] as string;
    let skCondition: { type: 'begins_with' | 'eq'; value: string } | undefined;
    const skEq = expr.match(/sk\s*=\s*(:\w+)/);
    if (skEq) skCondition = { type: 'eq', value: vals[skEq[1]] as string };
    const skPrefix = expr.match(/begins_with\(\s*sk\s*,\s*(:\w+)\s*\)/);
    if (skPrefix) skCondition = { type: 'begins_with', value: vals[skPrefix[1]] as string };
    const result = await this.store.queryPage<Record<string, unknown>>(pk, {
      skCondition, limit: input.Limit as number | undefined,
      scanForward: input.ScanIndexForward as boolean | undefined,
      filterExpression: input.FilterExpression as string | undefined,
      expressionAttributeNames: input.ExpressionAttributeNames as Record<string, string> | undefined,
      expressionAttributeValues: vals,
      projectionExpression: input.ProjectionExpression as string | undefined,
      indexName: input.IndexName as string | undefined,
    }, input.ExclusiveStartKey as Record<string, unknown> | undefined);
    return { Items: result.items, LastEvaluatedKey: result.lastEvaluatedKey, Count: result.items.length, $metadata: { httpStatusCode: 200 } };
  }

  private async _del(input: Record<string, unknown>) {
    const key = input.Key as CompositeKey;
    await this.store.delete(key);
    return { $metadata: { httpStatusCode: 200 } };
  }

  private async _update(input: Record<string, unknown>) {
    const key = input.Key as CompositeKey;
    const result = await this.store.update<Record<string, unknown>>(key, {
      updateExpression: input.UpdateExpression as string,
      conditionExpression: input.ConditionExpression as string | undefined,
      expressionAttributeNames: input.ExpressionAttributeNames as Record<string, string> | undefined,
      expressionAttributeValues: input.ExpressionAttributeValues as Record<string, unknown> | undefined,
      returnValues: (input.ReturnValues as string | undefined) ?? 'NONE',
    });
    return { Attributes: result ?? undefined, $metadata: { httpStatusCode: 200 } };
  }

  private async _scan(input: Record<string, unknown>) {
    const items = await this.store.scan<Record<string, unknown>>({
      filterExpression: (input.FilterExpression as string) ?? '',
      expressionAttributeValues: (input.ExpressionAttributeValues as Record<string, unknown>) ?? {},
      expressionAttributeNames: input.ExpressionAttributeNames as Record<string, string> | undefined,
      projectionExpression: input.ProjectionExpression as string | undefined,
      limit: input.Limit as number | undefined,
    });
    return { Items: items, Count: items.length, $metadata: { httpStatusCode: 200 } };
  }

  private async _batchWrite(input: Record<string, unknown>) {
    const reqItems = input.RequestItems as Record<string, Array<{ PutRequest?: { Item: Record<string, unknown> }; DeleteRequest?: { Key: CompositeKey } }>>;
    const ops: Array<{ type: 'put'; item: Record<string, unknown> & CompositeKey } | { type: 'delete'; key: CompositeKey }> = [];
    for (const requests of Object.values(reqItems)) {
      for (const req of requests) {
        if (req.PutRequest) ops.push({ type: 'put', item: req.PutRequest.Item as Record<string, unknown> & CompositeKey });
        else if (req.DeleteRequest) ops.push({ type: 'delete', key: req.DeleteRequest.Key });
      }
    }
    for (let i = 0; i < ops.length; i += 25) await this.store.batchWrite(ops.slice(i, i + 25));
    return { $metadata: { httpStatusCode: 200 } };
  }

  private async _transactWrite(input: Record<string, unknown>) {
    const items = input.TransactItems as Array<Record<string, unknown>>;
    const ops: Array<{ type: 'put'; item: Record<string, unknown> & CompositeKey } | { type: 'delete'; key: CompositeKey }> = [];
    for (const item of items) {
      if (item.Put) ops.push({ type: 'put', item: (item.Put as Record<string, unknown>).Item as Record<string, unknown> & CompositeKey });
      else if (item.Delete) ops.push({ type: 'delete', key: (item.Delete as Record<string, unknown>).Key as CompositeKey });
      else if (item.Update) {
        const u = item.Update as Record<string, unknown>;
        await this.store.update((u as Record<string, unknown>).Key as CompositeKey, {
          updateExpression: u.UpdateExpression as string,
          conditionExpression: u.ConditionExpression as string | undefined,
          expressionAttributeNames: u.ExpressionAttributeNames as Record<string, string> | undefined,
          expressionAttributeValues: u.ExpressionAttributeValues as Record<string, unknown> | undefined,
          returnValues: 'NONE',
        });
      } else if (item.ConditionCheck) {
        const cc = item.ConditionCheck as Record<string, unknown>;
        const existing = await this.store.get((cc as Record<string, unknown>).Key as CompositeKey);
        if ((cc.ConditionExpression as string).includes('attribute_not_exists') && existing) throw new Error('TransactionCanceledException');
        if ((cc.ConditionExpression as string).includes('attribute_exists') && !existing) throw new Error('TransactionCanceledException');
      }
    }
    if (ops.length > 0) for (let i = 0; i < ops.length; i += 25) await this.store.batchWrite(ops.slice(i, i + 25));
    return { $metadata: { httpStatusCode: 200 } };
  }
}
