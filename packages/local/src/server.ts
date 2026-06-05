/**
 * Local HTTP server — runs the swarm admin API and serves the admin UI.
 *
 * Creates local-first backends, injects them into ALL AWS client getters
 * (DynamoDB, S3, SQS, SecretsManager, Lambda) before any service modules
 * are loaded, then starts an Express server with real chat/avatar routes.
 */
import express from 'express';
import cors from 'cors';
import { createLocalServices } from './factories.js';
import { LocalS3Adapter } from './s3-adapter.js';
import { LocalSQSAdapter } from './sqs-adapter.js';
import { LocalSecretsAdapter } from './secrets-adapter.js';
import { LocalLambdaAdapter } from './lambda-adapter.js';

export { createLocalServices } from './factories.js';
export { SqliteRepository } from './sqlite-repository.js';
export { LocalBlobStore } from './blob-store.js';
export { InMemoryQueue } from './queue.js';
export { FileSecretsService } from './secrets.js';
export { LocalDynamoClientAdapter } from './dynamo-adapter.js';
export { LocalS3Adapter } from './s3-adapter.js';
export { LocalSQSAdapter } from './sqs-adapter.js';
export { LocalSecretsAdapter } from './secrets-adapter.js';
export { LocalLambdaAdapter } from './lambda-adapter.js';

export interface ServerOptions {
  port?: number;
  dbPath?: string;
  envFilePath?: string;
  blobDir?: string;
  adminUiPath?: string;
}

export async function startServer(options: ServerOptions = {}) {
  const port = options.port ?? 3000;
  const dataDir = options.blobDir ?? './data/blobs';
  const dbPath = options.dbPath ?? './data/swarm.db';

  // ── Create local backends ──────────────────────────────────────────
  const services = createLocalServices({
    dbPath,
    envFilePath: options.envFilePath ?? '.env',
    blobDir: dataDir,
    blobBaseUrl: `http://localhost:${port}/blobs`,
  });

  // ── Inject into admin-api BEFORE any handlers are imported ─────────
  // Order matters: adapters must be set before services call get*Client().

  // DynamoDB
  try {
    const { _setDynamoClient } = await import(
      '../../admin-api/src/services/dynamo-client.js'
    );
    _setDynamoClient(services.dynamoAdapter);
    console.log('[local] DynamoDB adapter injected into admin-api');
  } catch (err) {
    console.warn('[local] DynamoDB injection failed:', (err as Error).message);
  }

  // S3, SQS, Secrets, Lambda
  try {
    const aws = await import(
      '../../admin-api/src/services/aws-clients.js'
    );
    aws._setS3Client(new LocalS3Adapter(services.blobs));
    aws._setSQSClient(new LocalSQSAdapter(services.queue));
    aws._setSecretsClient(new LocalSecretsAdapter(services.secrets));
    aws._setLambdaClient(new LocalLambdaAdapter());
    console.log('[local] S3/SQS/Secrets/Lambda adapters injected into admin-api');
  } catch (err) {
    console.warn('[local] AWS clients injection failed:', (err as Error).message);
  }

  // ── Inject into core service setters ───────────────────────────────
  try {
    const core = await import('@swarm/core');
    const adapter = services.dynamoAdapter as unknown as Record<string, unknown>;
    const setters = [
      '_setCanonicalDynamoClient',
      '_setTierDynamoClient',
      '_setSharedRoomDynamoClient',
      '_setLongFormDynamoClient',
      '_setIdentityLinkDynamoClient',
    ];
    let injected = 0;
    for (const setter of setters) {
      const fn = (core as Record<string, unknown>)[setter];
      if (typeof fn === 'function') {
        fn(adapter);
        injected++;
      }
    }
    if (injected > 0) {
      console.log(`[local] DynamoDB adapter injected into @swarm/core (${injected} setters)`);
    }
  } catch (err) {
    console.warn('[local] Core injection failed:', (err as Error).message);
  }

  // ── Set up Express ─────────────────────────────────────────────────
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', backend: 'local', db: dbPath });
  });

  // Blob storage endpoint
  app.get('/blobs/:key', (req, res) => {
    const key = req.params['key'] as string;
    const blob = services.blobs.get(key);
    if (!blob) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const ext = key.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      wav: 'audio/wav',
      mp4: 'video/mp4',
      webm: 'video/webm',
      json: 'application/json',
    };
    res.type(mimeTypes[ext ?? ''] ?? 'application/octet-stream');
    res.send(blob);
  });

  // ── Admin API routes ───────────────────────────────────────────────
  try {
    await mountAdminRoutes(app);
  } catch (err) {
    console.warn('[local] Could not mount admin API routes:', (err as Error).message);
    mountStubRoutes(app);
  }

  // ── Admin UI (optional) ────────────────────────────────────────────
  if (options.adminUiPath) {
    app.use(express.static(options.adminUiPath));
    app.get('*', (_req, res) => {
      res.sendFile('index.html', { root: options.adminUiPath });
    });
  }

  // ── Start ──────────────────────────────────────────────────────────
  return new Promise<{ app: express.Express; services: typeof services }>(
    (resolve, reject) => {
      const server = app.listen(port, () => {
        console.log(`[local] Swarm server running at http://localhost:${port}`);
        console.log(`[local]   Database: ${dbPath}`);
        console.log(`[local]   Blobs:    ${dataDir}`);
        resolve({ app, services });
      });
      server.on('error', reject);
    },
  );
}

// ── Route mounting ────────────────────────────────────────────────────────

async function mountAdminRoutes(app: express.Express) {
  const { processChat } = await import(
    '../../admin-api/src/handlers/chat.js'
  );

  // POST /api/chat
  app.post('/api/chat', async (req, res) => {
    try {
      const { message, history = [], avatar, session: sessionOverride } =
        req.body as {
          message?: string;
          history?: Array<{ role: string; content: string }>;
          avatar?: { id: string };
          session?: { email?: string; userId?: string; isAdmin?: boolean };
        };

      if (!message && !history.length) {
        res.status(400).json({ error: 'message or history required' });
        return;
      }

      const session = {
        email: sessionOverride?.email ?? 'local@swarm.dev',
        userId: sessionOverride?.userId ?? 'local-user',
        isAdmin: sessionOverride?.isAdmin ?? true,
      };

      const result = await processChat(
        message ?? null,
        history as Array<{ role: string; content: string }>,
        session,
        avatar ? { id: avatar.id } : undefined,
      );

      res.json({
        response: result.response,
        history: result.history,
        avatar: result.avatar,
      });
    } catch (err) {
      console.error('[local] Chat error:', err);
      res.status(500).json({
        error: 'Chat processing failed',
        detail: (err as Error).message,
      });
    }
  });

  // GET /api/avatars
  app.get('/api/avatars', async (_req, res) => {
    try {
      const { listAvatars } = await import(
        '../../admin-api/src/services/avatars.js'
      );
      const session = { email: 'local@swarm.dev', userId: 'local-user', isAdmin: true };
      const avatars = await listAvatars(session);
      res.json({ avatars });
    } catch (err) {
      console.error('[local] Avatars error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  console.log('[local] Admin API routes mounted');
}

function mountStubRoutes(app: express.Express) {
  app.post('/api/chat', async (_req, res) => {
    res.json({ response: 'Chat endpoint (stub).', history: [] });
  });
  app.get('/api/avatars', async (_req, res) => {
    res.json({ avatars: [] });
  });
}

// ── Run directly ───────────────────────────────────────────────────────────

const port = parseInt(process.env.PORT ?? '3000', 10);
startServer({
  port,
  dbPath: process.env.SWARM_DB_PATH ?? './data/swarm.db',
  envFilePath: process.env.SWARM_ENV_FILE ?? '.env',
  blobDir: process.env.SWARM_BLOB_DIR ?? './data/blobs',
  adminUiPath: process.env.SWARM_ADMIN_UI_PATH,
}).catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
