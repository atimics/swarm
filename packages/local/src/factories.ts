/**
 * Local service factories — wire up the local-first backends.
 *
 * Creates all local infrastructure (SQLite, filesystem blob store,
 * in-memory queue, env-based secrets) plus a DynamoDB adapter that
 * routes admin-api service calls through the local KeyValueStore.
 */
import type { KeyValueStore, SecretsService } from '@swarm/core';
import { SqliteRepository } from './sqlite-repository.js';
import { FileSecretsService } from './secrets.js';
import { LocalBlobStore } from './blob-store.js';
import { InMemoryQueue } from './queue.js';
import { LocalDynamoClientAdapter } from './dynamo-adapter.js';

export interface LocalServicesOptions {
  dbPath?: string;
  envFilePath?: string;
  blobDir?: string;
  blobBaseUrl?: string;
  tableName?: string;
}

export interface LocalServices {
  store: KeyValueStore;
  dynamoAdapter: LocalDynamoClientAdapter;
  secrets: SecretsService;
  blobs: LocalBlobStore;
  queue: InMemoryQueue;
  shutdown: () => void;
}

export function createLocalServices(options: LocalServicesOptions = {}): LocalServices {
  const store = new SqliteRepository({
    dbPath: options.dbPath,
    tableName: options.tableName ?? 'swarm_items',
  });

  const dynamoAdapter = new LocalDynamoClientAdapter(store);

  const secrets = new FileSecretsService({
    envFilePath: options.envFilePath,
  });

  const blobs = new LocalBlobStore({
    rootDir: options.blobDir,
    baseUrl: options.blobBaseUrl,
  });

  const queue = new InMemoryQueue();

  return {
    store,
    dynamoAdapter,
    secrets,
    blobs,
    queue,
    shutdown: () => {
      store.close();
    },
  };
}
