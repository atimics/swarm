/**
 * Local HTTP server — runs the swarm admin API and serves the admin UI.
 */
import express from 'express';
import cors from 'cors';
import { createInterface } from 'readline';
import { createLocalServices } from './factories.js';
import { LocalS3Adapter } from './s3-adapter.js';
import { LocalSQSAdapter } from './sqs-adapter.js';
import { LocalSecretsAdapter } from './secrets-adapter.js';
import { LocalLambdaAdapter } from './lambda-adapter.js';

export { createLocalServices } from './factories.js';
export { SqliteRepository } from './sqlite-repository.js';
export { LocalBlobStore } from './blob-store.js';
export { InMemoryQueue } from './queue.js';
export { EncryptedSecretsService } from './encrypted-secrets.js';
export { LocalDynamoClientAdapter } from './dynamo-adapter.js';
export { LocalS3Adapter } from './s3-adapter.js';
export { LocalSQSAdapter } from './sqs-adapter.js';
export { LocalSecretsAdapter } from './secrets-adapter.js';
export { LocalLambdaAdapter } from './lambda-adapter.js';

export interface ServerOptions {
  port?: number;
  dbPath?: string;
  blobDir?: string;
  adminUiPath?: string;
  password?: string; // if provided, skip prompt
}

// ── Password prompt ──────────────────────────────────────────────────────

async function promptPassword(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function resolvePassword(options: ServerOptions): Promise<string> {
  if (options.password) return options.password;

  const fromArg = process.argv.find((a) => a.startsWith('--password='));
  if (fromArg) return fromArg.split('=')[1];

  const fromEnv = process.env.SWARM_ADMIN_PASSWORD;
  if (fromEnv) return fromEnv;

  return promptPassword('Admin password: ');
}

// ── Server ───────────────────────────────────────────────────────────────

export async function startServer(options: ServerOptions = {}) {
  const port = options.port ?? 3000;
  const dataDir = options.blobDir ?? './data/blobs';
  const dbPath = options.dbPath ?? './data/swarm.db';

  // ── Create local backends ──────────────────────────────────────────
  const services = createLocalServices({
    dbPath,
    blobDir: dataDir,
    blobBaseUrl: `http://localhost:${port}/blobs`,
  });

  // ── Unlock secrets ─────────────────────────────────────────────────
  const verify = await services.store.get({ pk: 'SYSTEM', sk: 'SECRETS_VERIFY' });
  const isInitialized = verify !== null;

  if (isInitialized) {
    let unlocked = false;
    while (!unlocked) {
      try {
        const pw = await resolvePassword(options);
        await services.secrets.unlock(pw);
        unlocked = true;
        console.log('[local] Secrets unlocked');
      } catch (err) {
        console.error('[local]', (err as Error).message);
        if (options.password) throw err; // don't loop if password was explicit
      }
    }
  } else {
    console.log('[local] First run — no secrets store found.');
    const pw = await promptPassword('Choose an admin password (min 8 chars): ');
    if (pw.length < 8) {
      console.error('[local] Password must be at least 8 characters.');
      process.exit(1);
    }
    const confirm = await promptPassword('Confirm password: ');
    if (pw !== confirm) {
      console.error('[local] Passwords do not match.');
      process.exit(1);
    }
    await services.secrets.initialize(pw);
    console.log('[local] Secrets store initialized and unlocked.');
  }

  // ── Inject into admin-api BEFORE any handlers are imported ─────────
  try {
    const { _setDynamoClient } = await import(
      '../../admin-api/src/services/dynamo-client.js'
    );
    _setDynamoClient(services.dynamoAdapter);
  } catch (err) {
    console.warn('[local] DynamoDB injection failed:', (err as Error).message);
  }

  try {
    const aws = await import('../../admin-api/src/services/aws-clients.js');
    aws._setS3Client(new LocalS3Adapter(services.blobs));
    aws._setSQSClient(new LocalSQSAdapter(services.queue));
    aws._setSecretsClient(new LocalSecretsAdapter(services.secrets));
    aws._setLambdaClient(new LocalLambdaAdapter());
    console.log('[local] AWS adapters injected');
  } catch (err) {
    console.warn('[local] AWS clients injection failed:', (err as Error).message);
  }

  // ── Inject into core setters ───────────────────────────────────────
  try {
    const core = await import('@swarm/core');
    const adapter = services.dynamoAdapter;
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
    if (injected > 0) console.log(`[local] Core setters injected (${injected})`);
  } catch {
    // core may not be importable
  }

  // ── Express ────────────────────────────────────────────────────────
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      backend: 'local',
      db: dbPath,
      secrets: services.secrets.isUnlocked ? 'unlocked' : 'locked',
    });
  });

  // Blob storage
  app.get('/blobs/:key', (req, res) => {
    const key = req.params['key'] as string;
    const blob = services.blobs.get(key);
    if (!blob) { res.status(404).json({ error: 'Not found' }); return; }
    const ext = key.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp',
      mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
      mp4: 'video/mp4', webm: 'video/webm', json: 'application/json',
    };
    res.type(mimeTypes[ext ?? ''] ?? 'application/octet-stream');
    res.send(blob);
  });

  // ── Admin API routes ───────────────────────────────────────────────
  try {
    await mountAdminRoutes(app, services);
  } catch (err) {
    console.warn('[local] Admin API routes unavailable:', (err as Error).message);
    mountStubRoutes(app);
  }

  // ── Admin UI ───────────────────────────────────────────────────────
  if (options.adminUiPath) {
    app.use(express.static(options.adminUiPath));
    app.get('*', (_req, res) => {
      res.sendFile('index.html', { root: options.adminUiPath });
    });
  }

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

// ── Route mounting ──────────────────────────────────────────────────────

async function mountAdminRoutes(
  app: express.Express,
  _services: ReturnType<typeof createLocalServices>,
) {
  const { processChat } = await import(
    '../../admin-api/src/handlers/chat.js'
  );

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
