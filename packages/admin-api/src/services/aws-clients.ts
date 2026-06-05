/**
 * Shared AWS clients with setters for local-first injection.
 *
 * Every admin-api service that creates an AWS client should use
 * these getters instead of `new S3Client({})` at module scope.
 * In local mode, inject compatible adapters via the setters before
 * any services are loaded.
 *
 * Pattern matches the existing dynamo-client.ts.
 */

import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { LambdaClient } from '@aws-sdk/client-lambda';

// ── Type-shapes for injectable clients ───────────────────────────────────

/** Minimal shape required for S3-compatible injection (PutObject / GetObject / DeleteObject). */
export interface S3LikeClient {
  send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<Record<string, unknown>>;
}

/** Minimal shape required for SQS-compatible injection (SendMessage etc.). */
export interface SQSLikeClient {
  send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<Record<string, unknown>>;
}

/** Minimal shape for SecretsManager-compatible injection. */
export interface SecretsLikeClient {
  send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<Record<string, unknown>>;
}

/** Minimal shape for Lambda-compatible injection. */
export interface LambdaLikeClient {
  send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<Record<string, unknown>>;
}

// ── S3 ───────────────────────────────────────────────────────────────────

let _s3Client: S3LikeClient | null = null;

export function getS3Client(): S3LikeClient {
  if (!_s3Client) {
    _s3Client = new S3Client({}) as unknown as S3LikeClient;
  }
  return _s3Client;
}

export function _setS3Client(client: S3LikeClient | null): void {
  _s3Client = client;
}

// ── SQS ──────────────────────────────────────────────────────────────────

let _sqsClient: SQSLikeClient | null = null;

export function getSQSClient(): SQSLikeClient {
  if (!_sqsClient) {
    _sqsClient = new SQSClient({}) as unknown as SQSLikeClient;
  }
  return _sqsClient;
}

export function _setSQSClient(client: SQSLikeClient | null): void {
  _sqsClient = client;
}

// ── Secrets Manager ──────────────────────────────────────────────────────

let _secretsClient: SecretsLikeClient | null = null;

export function getSecretsClient(): SecretsLikeClient {
  if (!_secretsClient) {
    _secretsClient = new SecretsManagerClient({}) as unknown as SecretsLikeClient;
  }
  return _secretsClient;
}

export function _setSecretsClient(client: SecretsLikeClient | null): void {
  _secretsClient = client;
}

// ── Lambda ───────────────────────────────────────────────────────────────

let _lambdaClient: LambdaLikeClient | null = null;

export function getLambdaClient(): LambdaLikeClient {
  if (!_lambdaClient) {
    _lambdaClient = new LambdaClient({}) as unknown as LambdaLikeClient;
  }
  return _lambdaClient;
}

export function _setLambdaClient(client: LambdaLikeClient | null): void {
  _lambdaClient = client;
}
