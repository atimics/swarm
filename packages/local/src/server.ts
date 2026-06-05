/**
 * Local HTTP server — runs the swarm admin API and serves the admin UI.
 */
import express from 'express';
import cors from 'cors';
import { createInterface } from 'readline';
import { randomBytes, createHash } from "crypto";
import { startTelegramPolling } from "./telegram-polling.js";
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

// ── Log buffer (in-memory + on-disk) ────────────────────────────────
import { appendFileSync, mkdirSync } from 'fs';

interface LogEntry {
  ts: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  message: string;
}

const logBuffer: LogEntry[] = [];
const MAX_LOG_ENTRIES = 500;
let logFilePath = '';

function initLogFile() {
  const home = process.env.HOME ?? '/tmp';
  const dir = `${home}/Library/Application Support/Swarm`;
  mkdirSync(dir, { recursive: true });
  logFilePath = `${dir}/swarm.log`;
}

function pushLog(level: LogEntry['level'], message: string) {
  const entry = { ts: new Date().toISOString(), level, message };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.shift();

  if (logFilePath) {
    try {
      appendFileSync(logFilePath, `[${entry.ts}] ${level} ${message}\n`);
    } catch { /* disk full or permissions */ }
  }
}

initLogFile();

const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
console.log = (...args: unknown[]) => { pushLog('INFO', args.map(String).join(' ')); origLog(...args); };
console.warn = (...args: unknown[]) => { pushLog('WARN', args.map(String).join(' ')); origWarn(...args); };
console.error = (...args: unknown[]) => { pushLog('ERROR', args.map(String).join(' ')); origError(...args); };

process.on('uncaughtException', (err) => {
  pushLog('ERROR', `Uncaught: ${err.message}\n${err.stack}`);
  if (logFilePath) {
    try { appendFileSync(logFilePath, err.stack + '\n'); } catch {}
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  pushLog('ERROR', `Unhandled rejection: ${String(reason)}`);
});


export interface ServerOptions {
  port?: number;
  dbPath?: string;
  blobDir?: string;
  adminUiPath?: string;
  password?: string;
  /** Custom password prompt (e.g. native dialog for GUI apps). */
  promptFn?: (message: string) => Promise<string>;
}

// ── Password prompt ──────────────────────────────────────────────────────

async function promptPassword(prompt: string, options: ServerOptions): Promise<string> {
  if (options.promptFn) return options.promptFn(prompt);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function resolvePassword(options: ServerOptions, allOptions: ServerOptions): Promise<string> {
  if (options.password) return options.password;

  const fromArg = process.argv.find((a) => a.startsWith('--password='));
  if (fromArg) return fromArg.split('=')[1];

  const fromEnv = process.env.SWARM_ADMIN_PASSWORD;
  if (fromEnv) return fromEnv;

  return promptPassword('Admin password: ');
}

// ── Server ───────────────────────────────────────────────────────────────
async function startTgPolling(services: ReturnType<typeof createLocalServices>) {
  try {
    const tgToken = await services.secrets.getSecret("telegram_bot_token").catch(() => null);
    if (!tgToken) {
      console.log("[local] No Telegram bot token configured, skipping polling.");
      return;
    }
    console.log("[local] Telegram bot token found, starting polling...");
    const stopPolling = startTelegramPolling({
      getToken: () => services.secrets.getSecret("telegram_bot_token").catch(() => null),
      processMessage: async (text, chatId, _username) => {
        const { processChat } = await import("../../admin-api/src/handlers/chat.js");
        const session = { email: "local@swarm.dev", userId: "local-user", isAdmin: true };
        const { listAvatars } = await import("../../admin-api/src/services/avatars.js");
        const avatars = await listAvatars(session);
        const avatar = avatars[0];
        if (!avatar) return "No avatar configured yet. Create one in the desktop app.";
        const result = await processChat(text, [], session, { id: avatar.avatarId || (avatar as any).id });
        return result.response;
      },
    });
    process.on("SIGINT", stopPolling);
    process.on("SIGTERM", stopPolling);
  } catch (err) {
    console.warn("[local] Telegram polling setup failed:", (err as Error).message);
  }
}

export async function startServer(options: ServerOptions = {}) {
  const port = options.port ?? 3000;
  const dataDir = options.blobDir ?? './data/blobs';
  const dbPath = options.dbPath ?? './data/swarm.db';

  // Local mode defaults — use simple secret names instead of AWS ARNs
  if (!process.env.LLM_API_KEY_SECRET_ARN) process.env.LLM_API_KEY_SECRET_ARN = "llm-api-key";
  if (!process.env.ADMIN_TABLE) process.env.ADMIN_TABLE = "swarm-local-admin";
  if (!process.env.STATE_TABLE) process.env.STATE_TABLE = "swarm-local-state";
  if (!process.env.MESSAGE_QUEUE_URL) process.env.MESSAGE_QUEUE_URL = "https://localhost/queue";
  if (!process.env.S3_BUCKET) process.env.S3_BUCKET = "swarm-local";

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
    const pw = options.password ?? await resolvePassword(options, options);
    try {
      await services.secrets.unlock(pw);
      console.log('[local] Secrets unlocked');
    } catch (err) {
      console.error('[local]', (err as Error).message);
      throw err;
    }
  } else {
    console.log('[local] First run — no secrets store found.');
    const pw = options.password ?? await promptPassword('Choose an admin password (min 8 chars): ', options);
    if (pw.length < 8) {
      console.error('[local] Password must be at least 8 characters.');
      process.exit(1);
    }
    if (!options.password) {
      const confirm = await promptPassword('Confirm password: ', options);
      if (pw !== confirm) {
        console.error('[local] Passwords do not match.');
        process.exit(1);
      }
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
      logFile: logFilePath,
    });
  });
  // Log viewer
  app.get('/api/logs', (_req, res) => {
    const limit = Math.min(parseInt(String(_req.query.limit)) || 50, MAX_LOG_ENTRIES);
    const level = String(_req.query.level || '').toUpperCase();
    const since = String(_req.query.since || '');
    const query = String(_req.query.query || '').toLowerCase();

    let entries = [...logBuffer];
    if (level) entries = entries.filter(e => e.level === level);
    if (query) entries = entries.filter(e => e.message.toLowerCase().includes(query));
    entries = entries.slice(-limit);

    res.json({ count: entries.length, total: logBuffer.length, entries });
  });

  // ── Auth routes (local mode: always authenticated as admin) ───────
  function localAuthMe(_req: express.Request, res: express.Response) {
    res.json({
      authenticated: true,
      local: true,
      user: {
        walletAddress: 'local-admin',
        displayName: 'Local Admin',
        email: 'local@swarm.dev',
      },
      account: {
        accountId: 'local-account',
        role: 'admin',
        identities: [{ type: 'wallet' as const, providerId: 'local-admin' }],
      },
      gateStatus: {
        nftsHeld: 999,
        avatarsCreated: 0,
        availableSlots: 999,
        canCreate: true,
        canAbandon: true,
        ownedNFTs: [],
      },
      gateWallet: null,
      gateStatusByWallet: {},
    });
  }

  app.get('/auth/me', localAuthMe);
  app.get('/api/auth/me', localAuthMe);

  app.post('/auth/logout', (_req, res) => {
    res.json({ success: true });
  });

  // -- OpenRouter PKCE OAuth ----------------------------------------
  const pendingPkce = new Map<string, { verifier: string; createdAt: number }>();

  app.get("/api/auth/openrouter", (_req, res) => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest().toString("base64url");
    const state = randomBytes(24).toString("base64url");
    pendingPkce.set(state, { verifier, createdAt: Date.now() });

    const authUrl = new URL("https://openrouter.ai/auth");
    authUrl.searchParams.set("callback_url", `http://localhost:${port}/callback`);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);

    // Return HTML that breaks out of iframe and redirects top window
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>window.top.location.href = "${authUrl.toString()}";</script></body></html>`);
  });

  app.get("/api/auth/openrouter/callback", (req, res) => {
    return res.redirect(`/callback?${new URLSearchParams(req.query as any).toString()}`);
  });

  app.get("/callback", async (req, res) => {
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");

    const pending = pendingPkce.get(state);
    if (!pending) { res.status(400).send("Unknown or expired auth state"); return; }
    pendingPkce.delete(state);
    if (Date.now() - pending.createdAt > 600_000) { res.status(400).send("Auth state expired"); return; }

    try {
      const r = await fetch("https://openrouter.ai/api/v1/auth/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, code_verifier: pending.verifier, code_challenge_method: "S256" }),
      });
      if (!r.ok) { res.status(502).send("Exchange failed (" + r.status + ")"); return; }
      const body = await r.json() as { key?: string };
      if (!body.key) { res.status(502).send("No key in response"); return; }

      await services.secrets.setSecret("llm-api-key", body.key);
      await services.secrets.flush();
      res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:system-ui;text-align:center;padding-top:80px;background:#0d0d0d;color:#e0e0e0"><h1>Connected</h1><p>Your OpenRouter API key has been saved.</p><p>You may close this window.</p></body></html>`);
    } catch (err) {
      console.error("[local] PKCE error:", err);
      res.status(502).send("Exchange failed");
    }
  });


  // -- Consent routes (local mode: always consented) ----------------
  app.get('/consent', (_req, res) => {
    res.json({
      consented: true,
      consent: {
        policyVersion: '1.3',
        acceptedAt: Date.now(),
        status: 'active',
      },
    });
  });

  app.post('/consent', (_req, res) => {
    res.json({
      consent: {
        policyVersion: '1.3',
        acceptedAt: Date.now(),
        status: 'active',
      },
    });
  });

  app.post('/consent/revoke', (_req, res) => {
    res.json({ success: true });
  });

  app.get("/api/consent", (_req, res) => {
    res.json({ consented: true, consent: { policyVersion: "1.3", acceptedAt: Date.now(), status: "active" } });
  });

  app.post("/api/consent", (_req, res) => {
    res.json({ consent: { policyVersion: "1.3", acceptedAt: Date.now(), status: "active" } });
  });

  app.post("/api/consent/revoke", (_req, res) => {
    res.json({ success: true });
  });


  // -- Secrets management (local mode) ------------------------------
  app.get("/api/secrets", async (_req, res) => {
    try {
      const names = await services.secrets.listSecrets();
      res.json({ secrets: names });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/secrets/:name", async (req, res) => {
    try {
      const value = await services.secrets.getSecret(req.params.name);
      res.json({ name: req.params.name, value });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.post("/api/secrets/:name", async (req, res) => {
    try {
      const { value } = req.body as { value: string };
      if (!value) { res.status(400).json({ error: "value required" }); return; }
      await services.secrets.setSecret(req.params.name, value);
      await services.secrets.flush();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/secrets/:name", async (req, res) => {
    try {
      await services.secrets.deleteSecret(req.params.name);
      await services.secrets.flush();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Blob storage
  app.get('/blobs/:key', (req, res) => {
  // ── Auth routes (local mode: always authenticated as admin) ───────
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

  // ── Client-side error reporting (always available) ───────────
  app.get("/api/log-client-error", (req, res) => {
    const m = String(req.query.m || "");
    const s = String(req.query.s || "");
    if (m) pushLog("ERROR", `[UI] ${m}${s ? " | " + s : ""}`);
    res.json({ ok: true });
  });

  app.post("/api/log-client-error", (req, res) => {
    const { message, stack, url } = req.body as { message?: string; stack?: string; url?: string };
    if (message) pushLog("ERROR", `[UI] ${message}${stack ? " | " + stack.split("\\n").slice(0, 2).join(" <- ") : ""} (at ${url || "unknown"})`);
    res.json({ ok: true });
  });

  // ── Admin UI ─────────────────────────────────────────────────
  if (options.adminUiPath) {
    app.use(express.static(options.adminUiPath));
    app.get('*', (_req, res) => {
      res.sendFile('index.html', { root: options.adminUiPath });
    });
  }

  return new Promise<{ app: express.Express; services: typeof services }>(
    async (resolve, reject) => {
      server.on("error", reject);
      const server = app.listen(port, () => {
        console.log(`[local] Swarm server running at http://localhost:${port}`);
        console.log(`[local]   Database: ${dbPath}`);
        console.log(`[local]   Blobs:    ${dataDir}`);

        // ── Telegram polling (local mode) ──────────────────────────
        startTgPolling(services).catch(err =>
          console.warn("[local] Telegram polling setup failed:", (err as Error).message)
        );

        resolve({ app, services });
      });
    },
  );
}

// ── Route mounting ──────────────────────────────────────────────────────

export async function mountAdminRoutes(
  app: express.Express,
  _services: ReturnType<typeof createLocalServices>,
  processChatOverride?: (...args: any[]) => Promise<any>,
) {
  const { processChat } = await import(
    '../../admin-api/src/handlers/chat.js'
  );
  const chat = processChatOverride ?? processChat;

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

      const result = await chat(
        message ?? null,
        history as Array<{ role: string; content: string }>,
        session,
        avatar ? { id: avatar.id } : undefined,
      );

      // Persist pending tool call so the tools resume endpoint can validate it
      if ((result as any).pendingToolCall && avatar?.id) {
        try {
          const { savePendingTool } = await import(
            "../../admin-api/src/services/pending-tools.js"
          );
          await savePendingTool({
            email: session.email,
            avatarId: avatar.id,
            toolCallId: (result as any).pendingToolCall.id,
            toolName: (result as any).pendingToolCall.name,
            arguments: (result as any).pendingToolCall.arguments,
          });
          console.log(`[local] Persisted pending tool call ${(result as any).pendingToolCall.id}`);
        } catch (e) {
          console.error("[local] Failed to persist pending tool:", e);
        }
      }

      res.json({
        response: result.response,
        history: result.history,
        avatar: result.avatar,
        pendingToolCall: (result as any).pendingToolCall,
        taskActions: (result as any).taskActions,
        media: (result as any).media,
        pendingJobs: (result as any).pendingJobs,
        avatarUpdates: (result as any).avatarUpdates,
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
      res.json(avatars);
    } catch (err) {
      console.error('[local] Avatars error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  console.log('[local] Admin API routes mounted');

  app.post("/api/avatars", async (req, res) => {
    try {
      const { createAvatar } = await import("../../admin-api/src/services/avatars.js");
      const session = { email: "local@swarm.dev", userId: "local-user", isAdmin: true };
      const { name, description } = req.body as { name?: string; description?: string };
      if (!name) { res.status(400).json({ error: "name required" }); return; }
      const avatar = await createAvatar(name, session, description);
      res.json(avatar);
    } catch (err) {
      console.error("[local] Create avatar error:", err);
      res.status(500).json({ error: (err as Error).message });
    }
  });
  // ── Avatar sub-routes (secrets, integrations, tokens) ────────────
  app.post("/api/avatars/:id/secrets", async (req, res) => {
    try {
      const { key, value } = req.body as { key?: string; value?: string };
      if (!key || !value) { res.status(400).json({ error: "key and value required" }); return; }
      const secretName = key.includes("_") ? key : `${key}_api_key`;
      console.log(`[local] Saving secret ${secretName} for avatar ${req.params.id}`);
      await _services.secrets.setSecret(secretName, value);
      await _services.secrets.flush();
      console.log(`[local] Secret ${secretName} saved successfully`);
      res.json({ success: true, message: `${key} stored securely` });
    } catch (err) {
      console.error(`[local] Secret save error for ${req.params.id}:`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/avatars/:id/secrets", async (_req, res) => {
    try {
      const names = await _services.secrets.listSecrets();
      res.json(names);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/avatars/:id/validate-token", async (req, res) => {
    try {
      const { type, value } = req.body as { type?: string; value?: string };
      if (!type || !value) { res.status(400).json({ error: "type and value required" }); return; }
      console.log(`[local] Validating token type=${type} for avatar ${req.params.id}`);
      if (type === "telegram_bot_token" || type === "discord_bot_token") {
        const looksValid = value.length > 20;
        res.json({ valid: looksValid, botInfo: looksValid ? { username: "local_bot" } : undefined });
      } else {
        res.json({ valid: true });
      }
    } catch (err) {
      console.error(`[local] Token validation error for ${req.params.id}:`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/avatars/:id/validate-ai-key", async (req, res) => {
    res.json({ valid: true });  // local mode always accepts keys
  });

  app.get("/api/avatars/:id/telegram/diagnose", async (_req, res) => {
    res.json({ status: "not_configured", message: "Telegram not configured in local mode" });
  });

  app.post("/api/avatars/:id/telegram/repair", async (_req, res) => {
    res.json({ success: false, message: "Telegram webhook repair not available in local mode" });
  });

  app.put("/api/avatars/:id", async (req, res) => {
    try {
      const { updateAvatar } = await import("../../admin-api/src/services/avatars.js");
      const session = { email: "local@swarm.dev", userId: "local-user", isAdmin: true };
      console.log(`[local] Updating avatar ${req.params.id}:`, JSON.stringify(req.body).slice(0, 200));
      const result = await updateAvatar(req.params.id, req.body, session);
      res.json(result);
    } catch (err) {
      console.error(`[local] Avatar update error for ${req.params.id}:`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.patch("/api/avatars/:id", async (req, res) => {
    try {
      const { updateAvatar } = await import("../../admin-api/src/services/avatars.js");
      const session = { email: "local@swarm.dev", userId: "local-user", isAdmin: true };
      const result = await updateAvatar(req.params.id, req.body, session);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/avatars/:id/integrations", async (_req, res) => {
    res.json({ integrations: {} });  // local mode: no integrations configured yet
  });

  app.post("/api/avatars/:id/integrations", async (req, res) => {
    try {
      const { updateAvatar } = await import("../../admin-api/src/services/avatars.js");
      const session = { email: "local@swarm.dev", userId: "local-user", isAdmin: true };
      const result = await updateAvatar(req.params.id, req.body, session);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/integrations/models", async (req, res) => {
    try {
      const integration = String(req.query.integration || "");
      // Return a basic model list for the integration
      const models = integration === "openrouter" ? [
        { id: "openai/gpt-4o", name: "GPT-4o", provider: "openai" },
        { id: "anthropic/claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic" },
        { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "google" },
        { id: "amazon/nova-2-lite-v1", name: "Nova 2 Lite", provider: "amazon" },
      ] : [];
      res.json({ models });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/avatars/:id/discord/status", async (_req, res) => {
    res.json({ connected: false, mode: "bot" });
  });

  app.get("/api/avatars/:id", async (req, res) => {
    try {
      const { getAvatar } = await import("../../admin-api/src/services/avatars.js");
      const session = { email: "local@swarm.dev", userId: "local-user", isAdmin: true };
      const avatar = await getAvatar(req.params.id, session);
      res.json(avatar);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Resume chat after tool result ───────────────────────────────
  app.post("/api/avatars/:id/tools/:toolCallId", async (req, res) => {
    try {
      const { result } = req.body as { result?: unknown };
      if (result === undefined) { res.status(400).json({ error: "result is required" }); return; }
      const { resumeChatAfterToolResult } = await import(
        "../../admin-api/src/handlers/chat.js"
      );
      const session = { email: "local@swarm.dev", userId: "local-user", isAdmin: true };
      const resumed = await resumeChatAfterToolResult({
        avatarId: req.params.id,
        toolCallId: req.params.toolCallId,
        result,
        session,
      });
      res.json({
        response: resumed.response,
        history: resumed.history,
        media: resumed.media,
        pendingJobs: resumed.pendingJobs,
        pendingToolCall: resumed.pendingToolCall,
        avatarUpdates: resumed.avatarUpdates,
      });
    } catch (err) {
      console.error(`[local] Tool resume error for ${req.params.id}:`, err);
      res.status(400).json({ error: (err as Error).message });
    }
  });

}

function mountStubRoutes(app: express.Express) {
  app.post('/api/chat', async (_req, res) => {
    res.json({ response: 'Chat endpoint (stub).', history: [] });
  });
  app.get('/api/avatars', async (_req, res) => {
    res.json({ avatars: [] });
  });
}
