/**
 * Shared DynamoDB Document Client (admin-api)
 *
 * The `_setDynamoClient` helper allows tests (or local-first backends)
 * to inject any send()-compatible client.
 *
 * In production, the real DynamoDBDocumentClient is created lazily.
 * In local mode, inject an adapter before any service imports.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export interface DynamoLikeClient {
  send(command: { constructor: { name: string }; input: unknown }): Promise<unknown>;
}

let _client: DynamoLikeClient | null = null;

export function getDynamoClient(): DynamoLikeClient {
  if (!_client) {
    _client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }) as unknown as DynamoLikeClient;
  }
  return _client;
}

export function _setDynamoClient(client: DynamoLikeClient | null): void {
  _client = client;
}
