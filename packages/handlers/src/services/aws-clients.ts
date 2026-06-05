/**
 * Shared AWS clients with setters for local-first injection (handlers package).
 *
 * Mirrors admin-api's aws-clients.ts for the handler Lambda functions.
 */

import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { LambdaClient } from '@aws-sdk/client-lambda';

export interface S3LikeClient {
  send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<Record<string, unknown>>;
}

export interface SQSLikeClient {
  send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<Record<string, unknown>>;
}

export interface SecretsLikeClient {
  send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<Record<string, unknown>>;
}

export interface LambdaLikeClient {
  send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<Record<string, unknown>>;
}

let _s3Client: S3LikeClient | null = null;
let _sqsClient: SQSLikeClient | null = null;
let _secretsClient: SecretsLikeClient | null = null;
let _lambdaClient: LambdaLikeClient | null = null;

export function getS3Client(): S3LikeClient {
  if (!_s3Client) _s3Client = new S3Client({}) as unknown as S3LikeClient;
  return _s3Client;
}
export function _setS3Client(c: S3LikeClient | null): void { _s3Client = c; }

export function getSQSClient(): SQSLikeClient {
  if (!_sqsClient) _sqsClient = new SQSClient({}) as unknown as SQSLikeClient;
  return _sqsClient;
}
export function _setSQSClient(c: SQSLikeClient | null): void { _sqsClient = c; }

export function getSecretsClient(): SecretsLikeClient {
  if (!_secretsClient) _secretsClient = new SecretsManagerClient({}) as unknown as SecretsLikeClient;
  return _secretsClient;
}
export function _setSecretsClient(c: SecretsLikeClient | null): void { _secretsClient = c; }

export function getLambdaClient(): LambdaLikeClient {
  if (!_lambdaClient) _lambdaClient = new LambdaClient({}) as unknown as LambdaLikeClient;
  return _lambdaClient;
}
export function _setLambdaClient(c: LambdaLikeClient | null): void { _lambdaClient = c; }
