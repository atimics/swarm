/**
 * Shared DynamoDB Document Client (handlers)
 *
 * Provides a singleton DynamoDBDocumentClient for reuse across all
 * handler modules, avoiding redundant client instantiation per module.
 *
 * The `_setDynamoClient` helper allows tests to inject a mock client.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

let _client: DynamoDBDocumentClient | null = null;

export function getDynamoClient(): DynamoDBDocumentClient {
  if (!_client) {
    _client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return _client;
}

/** For testing -- inject a mock client */
export function _setDynamoClient(client: DynamoDBDocumentClient | null): void {
  _client = client;
}
