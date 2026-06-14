/**
 * Local HTTP server — runs the swarm admin API and serves the admin UI.
 */
import express from 'express';
import cors from 'cors';
import type { CorsOptions } from 'cors';
import { createInterface } from 'readline';
import { randomBytes, createHash } from "crypto";
import { execFile } from 'node:child_process';
import { startTelegramPolling } from "./telegram-polling.js";
import { isOllamaAvailable, getOllamaModel, getOllamaEndpoint } from "./llm-ollama.js";
import { getRatiBalance, getSolBalance } from "./rati-auto-bridge.js";
import { createLocalServices } from './factories.js';
import { RuntimeSupervisor } from './runtime-supervisor.js';
import { LocalS3Adapter } from './s3-adapter.js';
import { LocalSQSAdapter } from './sqs-adapter.js';
import { LocalSecretsAdapter } from './secrets-adapter.js';
import { LocalLambdaAdapter } from './lambda-adapter.js';
import type { UserSession } from '@swarm/admin-api';

export { createLocalServices } from './factories.js';

type LocalServices = ReturnType<typeof createLocalServices>;

// Module-level state for cross-route communication
interface SignalIdentity {
  pubkey?: string;
  encryptedSeed?: string;
}

const _signalState: {
  latestAvatarId: string | null;
  latestPubkey: string | null;
  latestIdentity: SignalIdentity | null;
  treasuryConfig: { minerShare: number; treasuryShare: number; lpPoolAddress?: string };
} = {
  latestAvatarId: null,
  latestPubkey: null,
  latestIdentity: null,
  treasuryConfig: { minerShare: 0.10, treasuryShare: 0.90 },
};
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
    try { appendFileSync(logFilePath, err.stack + '\n'); } catch {
      // Best-effort crash logging only.
    }
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

function localAdminSession(): UserSession {
  return {
    email: 'local@swarm.dev',
    userId: 'local-user',
    isAdmin: true,
    accessToken: 'local-admin',
  };
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

// ── Server ───────────────────────────────────────────────────────────────
async function startTgPolling(services: ReturnType<typeof createLocalServices>) {
  try {
    const tgToken = await services.secrets.getSecret("telegram_bot_token").catch(() => null);
    if (!tgToken) {
      console.log("[local] No Telegram bot token configured, skipping polling.");
      return;
    }
    console.log("[local] Telegram bot token found, starting polling...");

    let cachedAvatarId: string | null = null;
    const stopPolling = startTelegramPolling({
      getToken: () => services.secrets.getSecret("telegram_bot_token").catch(() => null),
      getAvatarId: async () => {
        if (cachedAvatarId) return cachedAvatarId;
        const { listAvatars } = await import("../../admin-api/src/services/avatars.js");
        const avatars = await listAvatars();
        const first = avatars[0] as { avatarId?: string; id?: string } | undefined;
        if (first) cachedAvatarId = first.avatarId || first.id || null;
        return cachedAvatarId;
      },
      loadHistory: async (session, avatarId) => {
        const { getChatHistory } = await import("../../admin-api/src/services/chat-history.js");
        return getChatHistory(session, avatarId);
      },
      saveHistory: async (session, avatarId, history) => {
        const { saveChatHistory } = await import("../../admin-api/src/services/chat-history.js");
        await saveChatHistory(session, history, avatarId);
      },
      processMessage: async (text, history, session, avatarId) => {
        const { processChat } = await import("../../admin-api/src/handlers/chat.js");
        return processChat(text, history, session, { id: avatarId });
      },
    });
    process.on("SIGINT", stopPolling);
    process.on("SIGTERM", stopPolling);
  } catch (err) {
    console.warn("[local] Telegram polling setup failed:", (err as Error).message);
  }
}

// ── Extracted helpers (testable independently) ──────────────────────────

/** Set local-mode env vars so admin-api services don't crash on missing config. */
export function setupLocalEnv(): void {
  if (!process.env.LLM_API_KEY_SECRET_ARN) process.env.LLM_API_KEY_SECRET_ARN = "llm-api-key";
  if (!process.env.ADMIN_TABLE) process.env.ADMIN_TABLE = "swarm-local-admin";
  if (!process.env.STATE_TABLE) process.env.STATE_TABLE = "swarm-local-state";
  if (!process.env.MESSAGE_QUEUE_URL) process.env.MESSAGE_QUEUE_URL = "https://localhost/queue";
  if (!process.env.S3_BUCKET) process.env.S3_BUCKET = "swarm-local-blobs";

  const port = parseInt(process.env.PORT || '3000', 10);
  if (!process.env.CDN_URL) process.env.CDN_URL = `http://localhost:${port}/blobs`;
  if (!process.env.MEDIA_BUCKET) process.env.MEDIA_BUCKET = "swarm-local-blobs";
}

export interface InitSecretsOptions {
  password?: string;
  /** Called when a password is needed interactively. Only used in TTY mode. */
  onPasswordNeeded?: (prompt: string) => Promise<string>;
}

export interface InitSecretsResult {
  outcome: 'unlocked' | 'initialized' | 'needs_password';
  error?: string;
}

/**
 * Initialize or unlock the secrets store.
 *
 * In test/CI environments, pass `password` directly.
 * In interactive mode, provide `onPasswordNeeded` for prompting.
 * Does NOT call process.exit() — callers handle errors.
 */
export async function initSecrets(
  services: ReturnType<typeof createLocalServices>,
  options: InitSecretsOptions = {},
): Promise<InitSecretsResult> {
  const verify = await services.store.get({ pk: 'SYSTEM', sk: 'SECRETS_VERIFY' });
  const isInitialized = verify !== null;

  // Fall back to SWARM_ADMIN_PASSWORD env var if no password provided
  const resolvedPassword = options.password || process.env.SWARM_ADMIN_PASSWORD;

  if (isInitialized) {
    const pw = resolvedPassword ?? (options.onPasswordNeeded
      ? await options.onPasswordNeeded('Enter admin password: ')
      : undefined);
    if (!pw) return { outcome: 'needs_password', error: 'No password provided for existing secrets store.' };
    try {
      await services.secrets.unlock(pw);
      return { outcome: 'unlocked' };
    } catch (err) {
      return { outcome: 'needs_password', error: (err as Error).message };
    }
  }

  // First run — initialize
  const pw = resolvedPassword ?? (options.onPasswordNeeded
    ? await options.onPasswordNeeded('Choose an admin password (min 8 chars): ')
    : undefined);
  if (!pw) return { outcome: 'needs_password', error: 'No password provided for first-run initialization.' };
  if (pw.length < 8) return { outcome: 'needs_password', error: 'Password must be at least 8 characters.' };

  if (!resolvedPassword && options.onPasswordNeeded) {
    const confirm = await options.onPasswordNeeded('Confirm password: ');
    if (pw !== confirm) return { outcome: 'needs_password', error: 'Passwords do not match.' };
  }

  await services.secrets.initialize(pw);
  return { outcome: 'initialized' };
}

/**
 * Inject local adapters into admin-api + core modules.
 * Must be called BEFORE any admin-api handlers are imported.
 */
export async function injectLocalAdapters(
  services: ReturnType<typeof createLocalServices>,
): Promise<void> {
  const { _setDynamoClient } = await import('../../admin-api/src/services/dynamo-client.js');
  _setDynamoClient(services.dynamoAdapter);

  const aws = await import('../../admin-api/src/services/aws-clients.js');
  aws._setS3Client(new LocalS3Adapter(services.blobs));
  aws._setSQSClient(new LocalSQSAdapter(services.queue));
  aws._setSecretsClient(new LocalSecretsAdapter(services.secrets));
  aws._setLambdaClient(new LocalLambdaAdapter());

  const core = await import('@swarm/core');
  const adapter = services.dynamoAdapter;
  const setters = [
    '_setCanonicalDynamoClient', '_setTierDynamoClient',
    '_setSharedRoomDynamoClient', '_setLongFormDynamoClient',
    '_setIdentityLinkDynamoClient',
  ];
  let injected = 0;
  for (const setter of setters) {
    const fn = (core as Record<string, unknown>)[setter];
    if (typeof fn === 'function') { fn(adapter); injected++; }
  }
  if (injected > 0) console.log(`[local] Core setters injected (${injected})`);
}


export async function startServer(options: ServerOptions = {}) {
  const port = options.port ?? 3000;
  const dataDir = options.blobDir ?? './data/blobs';
  const dbPath = options.dbPath ?? './data/swarm.db';

  setupLocalEnv();


  // ── Ollama fallback (detect before any LLM imports) ──────────
  const ollamaAvailable = await isOllamaAvailable();
  if (ollamaAvailable && !process.env.LLM_API_KEY && !process.env.OPENROUTER_API_KEY) {
    const ollamaModel = await getOllamaModel();
    if (ollamaModel) {
      process.env.LLM_ENDPOINT = getOllamaEndpoint();
      process.env.LLM_API_KEY = "ollama";
      process.env.LLM_MODEL = ollamaModel;
      console.log(`[local] Ollama detected — using model "${ollamaModel}" at ${process.env.LLM_ENDPOINT}`);
    }
  }

  // ── Create local backends ──────────────────────────────────────────
  const services = createLocalServices({
    dbPath,
    blobDir: dataDir,
    blobBaseUrl: `http://localhost:${port}/blobs`,
  });

  // ── Unlock secrets ─────────────────────────────────────────────────
  const secretsResult = await initSecrets(services, {
    password: options.password,
    onPasswordNeeded: options.password
      ? undefined
      : async (prompt: string) => {
          // Interactive password prompt (TTY only)
          if (process.stdin.isTTY) return promptPassword(prompt, options);
          throw new Error('No password provided and stdin is not a TTY.');
        },
  });

  if (secretsResult.outcome === 'needs_password') {
    console.error('[local]', secretsResult.error);
    if (!options.password) process.exit(1);
    throw new Error(secretsResult.error!);
  }
  console.log(`[local] Secrets ${secretsResult.outcome}`);

  await injectLocalAdapters(services);

  // ── Express ────────────────────────────────────────────────────────
  const app = express();
  app.use(cors(localCorsOptions(port)));
  installLocalRequestGuard(app, port);
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

  app.get('/api/health', (_req, res) => {
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

  async function localLogout(_req: express.Request, res: express.Response) {
    await services.secrets.deleteSecret('llm-provider').catch(() => undefined);
    await services.secrets.deleteSecret('llm-api-key').catch(() => undefined);
    await services.secrets.deleteSecret('agent-backend').catch(() => undefined);
    await services.secrets.deleteSecret('agent-backend-endpoint').catch(() => undefined);
    await services.secrets.deleteSecret('agent-backend-api-key').catch(() => undefined);
    await services.secrets.flush();
    try {
      const { clearChatHistory } = await import('../../admin-api/src/services/chat-history.js');
      const { listAvatars } = await import('../../admin-api/src/services/avatars.js');
      const session = {
        email: 'local@swarm.dev',
        userId: 'local-user',
        isAdmin: true,
        accessToken: 'local',
      };
      await clearChatHistory(session, undefined);
      const avatars = await listAvatars();
      await Promise.all(avatars.map((avatar) => clearChatHistory(
        session,
        (avatar as { avatarId?: string; id?: string }).avatarId || (avatar as { id?: string }).id,
      )));
    } catch (err) {
      console.warn('[local] Failed to clear chat history on logout:', err);
    }
    res.json({ success: true, aiDisconnected: true });
  }

  app.post('/auth/logout', localLogout);
  app.post('/api/auth/logout', localLogout);

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
    const query = new URLSearchParams(
      Object.entries(req.query).flatMap(([key, value]) => {
        if (Array.isArray(value)) {
          return value.map((item) => [key, String(item)] as [string, string]);
        }
        return [[key, String(value)] as [string, string]];
      }),
    );
    return res.redirect(`/callback?${query.toString()}`);
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
      await services.secrets.setSecret("llm-provider", "openrouter");
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
      res.json({ name: req.params.name, exists: true, value });
    } catch {
      res.json({ name: req.params.name, exists: false });
    }
  });

  app.post("/api/secrets/:name", async (req, res) => {
    try {
      const { value } = req.body as { value: string };
      if (!value) { res.status(400).json({ error: "value required" }); return; }
      await services.secrets.setSecret(req.params.name, value);
      if (req.params.name === 'llm-api-key') {
        await services.secrets.setSecret('llm-provider', 'openrouter');
      }
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

  // ── RATi wallet balance ─────────────────────────────────────────
  app.get("/api/rati/treasury", (_req, res) => {
    res.json({
      minerShare: _signalState.treasuryConfig.minerShare,
      treasuryShare: _signalState.treasuryConfig.treasuryShare,
      lpPoolAddress: _signalState.treasuryConfig.lpPoolAddress || null,
      description: "10% to miners (relay bounty), 90% locked in station treasury for LP deposit.",
    });
  });

  app.get("/api/rati/balance", async (_req, res) => {
    try {
      if (!_signalState.latestPubkey) {
        res.json({ balance: 0, message: "No avatar yet. Create one first." });
        return;
      }
      const [ratiBalance, solBalance] = await Promise.all([
        getRatiBalance(_signalState.latestPubkey),
        getSolBalance(_signalState.latestPubkey),
      ]);
      res.json({
        pubkey: _signalState.latestPubkey,
        ratiBalance,
        solBalance,
        ratiMint: "8ZscSWe5ZSFbGYg4JzA3eqpf6iCnwT72i8TZvVni2yMY",
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
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


  // ── Signal integration: export avatar keypair ──────────────────────
  app.get("/api/signal/keypair", async (_req, res) => {
    try {
      // Use stored identity from avatar creation
      if (!_signalState.latestAvatarId || !_signalState.latestIdentity) {
        res.status(404).json({ error: "No avatar found. Create one first." });
        return;
      }
      const avatarId = _signalState.latestAvatarId;
      const identity = _signalState.latestIdentity;

      // Try to read the seed from secrets service
      let seedB64: string | undefined;
      try {
        const { GetSecretValueCommand } = await import("@swarm/core");
        const { getSecretsClient } = await import("../../admin-api/src/services/aws-clients.js");
        const secretsClient = getSecretsClient();
        const response = await secretsClient.send(new GetSecretValueCommand({
          SecretId: `avatar/${avatarId}/identity-seed`
        }));
        if (response.SecretString) {
          seedB64 = response.SecretString as string;
        }
      } catch {
        // Fall through to legacy path
      }

      // Legacy: use encryptedSeed from the identity record
      if (!seedB64 && identity.encryptedSeed) {
        seedB64 = identity.encryptedSeed;
      }

      if (!seedB64) {
        res.status(404).json({ error: "No identity keypair found. Create an avatar first." });
        return;
      }

      res.json({
        avatarId,
        pubkey: identity.pubkey || _signalState.latestPubkey,
        seedBase64: seedB64,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });





  // ── Admin UI ─────────────────────────────────────────────────
  if (options.adminUiPath) {
    app.use(express.static(options.adminUiPath));
    app.get('*', (_req, res) => {
      res.sendFile('index.html', { root: options.adminUiPath });
    });
  }

  return new Promise<{ app: express.Express; services: typeof services }>(
    (resolve, reject) => {
      const server = app.listen(port, '127.0.0.1', () => {
        console.log(`[local] Swarm server running at http://127.0.0.1:${port}`);
        console.log(`[local]   Database: ${dbPath}`);
        console.log(`[local]   Blobs:    ${dataDir}`);

        // ── Telegram polling (local mode) ──────────────────────────
        startTgPolling(services).catch(err =>
          console.warn("[local] Telegram polling setup failed:", (err as Error).message)
        );

        resolve({ app, services });
      });
      server.on("error", reject);
    },
  );
}

// ── Route mounting ──────────────────────────────────────────────────────

type ChatHistoryMessage = { role: string; content: string; [key: string]: unknown };
type LocalSession = { email: string; userId: string; isAdmin: boolean; accessToken: string };
type PendingToolCall = { id: string; name: string; arguments: Record<string, unknown> };
type ChatRouteResult = {
  response?: string;
  history?: ChatHistoryMessage[];
  avatar?: unknown;
  pendingToolCall?: PendingToolCall;
  taskActions?: unknown;
  media?: unknown;
  pendingJobs?: unknown;
  avatarUpdates?: unknown;
};
type ChatProcessor = (
  message: string | null,
  history: ChatHistoryMessage[],
  session: LocalSession,
  avatar?: { id: string },
) => Promise<ChatRouteResult>;

type ExternalBackendPayload = {
  message: string | null;
  history: ChatHistoryMessage[];
  avatar?: { id: string };
  session: LocalSession;
  backend: AgentBackendId;
};

type AgentBackendId =
  | 'swarm-native'
  | 'hermes'
  | 'elizaos'
  | 'milady'
  | 'claude-code'
  | 'codex'
  | 'openclaw'
  | 'cosyworld'
  | 'custom';
type AgentBackendAuthMode = 'none' | 'api-key' | 'oauth' | 'local-process';
type AgentRuntimeDeploymentTarget = 'local' | 'fly' | 'ecs';
type AgentBackendCapabilities = {
  chat: boolean;
  tools: boolean;
  memory: boolean;
  autonomousLoop: boolean;
  codeExecution: boolean;
  multimodal: boolean;
};
type AgentBackendDefinition = {
  id: AgentBackendId;
  name: string;
  description: string;
  authMode: AgentBackendAuthMode;
  requiresEndpoint: boolean;
  contextWindow: number;
  install: {
    summary: string;
    commands: string[];
    docsUrl?: string;
    endpointHint?: string;
  };
  /** Best-guess default for launching this runtime locally; editable in the UI. */
  launch?: {
    command: string;
    endpoint?: string;
    /** Containerized launch template (image is a placeholder to fill in). */
    docker?: { command: string; endpoint?: string };
  };
  cloud?: {
    fly?: {
      command?: string;
      endpointHint: string;
    };
    ecs?: {
      supported: boolean;
      endpointHint: string;
    };
  };
  capabilities: AgentBackendCapabilities;
};
type AgentBackendStatus = {
  selected: AgentBackendId;
  selectedBackend: AgentBackendDefinition;
  configured: boolean;
  endpoint?: string;
  hasApiKey: boolean;
  deploymentTarget: AgentRuntimeDeploymentTarget;
  scope: {
    avatarId?: string;
    label: string;
  };
  backends: AgentBackendDefinition[];
};

const AGENT_BACKENDS: AgentBackendDefinition[] = [
  {
    id: 'swarm-native',
    name: 'Swarm Native',
    description: 'Built-in Swarm chat loop, MCP tools, avatar state, and local context management.',
    authMode: 'none',
    requiresEndpoint: false,
    contextWindow: 4096,
    install: {
      summary: 'Built in. No separate runtime install is required.',
      commands: [],
    },
    capabilities: {
      chat: true,
      tools: true,
      memory: true,
      autonomousLoop: true,
      codeExecution: false,
      multimodal: true,
    },
  },
  {
    id: 'hermes',
    name: 'Hermes',
    description: 'External Hermes-compatible agent runtime reached through a configured HTTP endpoint.',
    authMode: 'api-key',
    requiresEndpoint: true,
    contextWindow: 4096,
    install: {
      summary: 'Install Hermes Agent, complete portal setup, then start the local proxy. Swarm will use the default proxy endpoint automatically.',
      commands: [
        'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | sh',
        'hermes setup --portal',
      ],
      docsUrl: 'https://hermes-agent.nousresearch.com/docs/',
      endpointHint: 'Swarm uses the default local Hermes endpoint automatically.',
    },
    launch: {
      command: 'hermes proxy start --port 8645',
      endpoint: 'http://localhost:8645',
      docker: {
        command: 'docker run --rm --name swarm-rt-hermes -p 8645:8645 your-hermes-image proxy start --host 0.0.0.0 --port 8645',
        endpoint: 'http://localhost:8645',
      },
    },
    cloud: {
      fly: {
        command: 'fly launch --name swarm-hermes-runtime && fly secrets set HERMES_TOKEN=...',
        endpointHint: 'Deploy a Hermes proxy to Fly.io, then paste the https://*.fly.dev endpoint.',
      },
      ecs: {
        supported: false,
        endpointHint: 'ECS launch templates are planned for the same runtime contract.',
      },
    },
    capabilities: {
      chat: true,
      tools: true,
      memory: true,
      autonomousLoop: true,
      codeExecution: false,
      multimodal: false,
    },
  },
  {
    id: 'elizaos',
    name: 'elizaOS',
    description: 'TypeScript agent framework backend for personalities, plugins, and autonomous actions.',
    authMode: 'api-key',
    requiresEndpoint: true,
    contextWindow: 4096,
    install: {
      summary: 'Install the elizaOS CLI, create or open an agent project, start it, then paste the local server endpoint.',
      commands: [
        'bun i -g @elizaos/cli',
        'elizaos create',
        'elizaos start',
      ],
      docsUrl: 'https://docs.elizaos.ai/',
      endpointHint: 'Swarm uses the default local elizaOS endpoint automatically.',
    },
    launch: {
      command: 'elizaos start',
      endpoint: 'http://localhost:3000',
      docker: {
        command: 'docker run --rm --name swarm-rt-elizaos -p 3000:3000 your-elizaos-image start',
        endpoint: 'http://localhost:3000',
      },
    },
    cloud: {
      fly: {
        command: 'fly launch --name swarm-elizaos-runtime',
        endpointHint: 'Deploy the elizaOS service to Fly.io, then paste the app endpoint.',
      },
      ecs: {
        supported: false,
        endpointHint: 'ECS support will reuse this cloud endpoint contract later.',
      },
    },
    capabilities: {
      chat: true,
      tools: true,
      memory: true,
      autonomousLoop: true,
      codeExecution: false,
      multimodal: true,
    },
  },
  {
    id: 'milady',
    name: 'milady.ai',
    description: 'External milady.ai agent backend for hosted avatar runtime experiments.',
    authMode: 'api-key',
    requiresEndpoint: true,
    contextWindow: 4096,
    install: {
      summary: 'Connect a hosted or self-managed milady.ai-compatible agent endpoint.',
      commands: [],
      endpointHint: 'Paste the milady.ai agent endpoint and API key from your runtime.',
    },
    capabilities: {
      chat: true,
      tools: true,
      memory: true,
      autonomousLoop: true,
      codeExecution: false,
      multimodal: true,
    },
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Local Claude Code or Agent SDK runtime for code-aware agent work.',
    authMode: 'local-process',
    requiresEndpoint: false,
    contextWindow: 4096,
    install: {
      summary: 'Install Claude Code locally and sign in. Swarm can then use the local process adapter once execution wiring is enabled.',
      commands: [
        'npm install -g @anthropic-ai/claude-code',
        'claude',
      ],
      docsUrl: 'https://code.claude.com/docs/en/quickstart',
    },
    capabilities: {
      chat: true,
      tools: true,
      memory: false,
      autonomousLoop: true,
      codeExecution: true,
      multimodal: false,
    },
  },
  {
    id: 'codex',
    name: 'Codex',
    description: 'Local Codex CLI runtime for code-aware agent work and repository operations.',
    authMode: 'local-process',
    requiresEndpoint: false,
    contextWindow: 4096,
    install: {
      summary: 'Install Codex CLI locally and sign in with ChatGPT or an API key.',
      commands: [
        'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
        'codex',
      ],
      docsUrl: 'https://developers.openai.com/codex/cli',
    },
    capabilities: {
      chat: true,
      tools: true,
      memory: false,
      autonomousLoop: true,
      codeExecution: true,
      multimodal: false,
    },
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    description: 'External OpenClaw personal-agent backend for messaging, scheduling, and workflow actions.',
    authMode: 'api-key',
    requiresEndpoint: true,
    contextWindow: 4096,
    install: {
      summary: 'Install OpenClaw, run onboarding, then paste the gateway endpoint.',
      commands: [
        'npm install -g openclaw@latest',
        'openclaw onboard --install-daemon',
        'openclaw setup',
      ],
      docsUrl: 'https://docs.openclaw.ai/install',
      endpointHint: 'Swarm uses the default local OpenClaw gateway endpoint automatically.',
    },
    launch: {
      command: 'openclaw gateway',
      endpoint: 'http://localhost:8787',
      docker: {
        command: 'docker run --rm --name swarm-rt-openclaw -p 8787:8787 your-openclaw-image gateway',
        endpoint: 'http://localhost:8787',
      },
    },
    capabilities: {
      chat: true,
      tools: true,
      memory: true,
      autonomousLoop: true,
      codeExecution: false,
      multimodal: true,
    },
  },
  {
    id: 'cosyworld',
    name: 'CosyWorld',
    description: 'Sibling ../cosyworld runtime for world, avatar, Discord, memory, and story systems.',
    authMode: 'api-key',
    requiresEndpoint: true,
    contextWindow: 4096,
    install: {
      summary: 'Use the sibling ../cosyworld checkout. Install dependencies once, then launch it on a Swarm-safe port.',
      commands: [
        'cd ../cosyworld && npm install',
        'cd ../cosyworld && WEB_PORT=3101 npm run dev',
      ],
      endpointHint: 'Swarm uses the default local CosyWorld endpoint automatically.',
    },
    launch: {
      command: 'cd ../cosyworld && WEB_PORT=3101 npm run dev',
      endpoint: 'http://localhost:3101',
      docker: {
        command: 'docker run --rm --name swarm-rt-cosyworld -p 3101:3000 your-cosyworld-image',
        endpoint: 'http://localhost:3101',
      },
    },
    cloud: {
      fly: {
        command: 'cd ../cosyworld && fly launch --name swarm-cosyworld-runtime',
        endpointHint: 'Deploy ../cosyworld to Fly.io, then paste the Fly app endpoint.',
      },
      ecs: {
        supported: false,
        endpointHint: 'ECS is planned after the Fly.io target settles.',
      },
    },
    capabilities: {
      chat: true,
      tools: true,
      memory: true,
      autonomousLoop: true,
      codeExecution: false,
      multimodal: true,
    },
  },
  {
    id: 'custom',
    name: 'Custom',
    description: 'Bring your own agent backend through an HTTP endpoint.',
    authMode: 'api-key',
    requiresEndpoint: true,
    contextWindow: 4096,
    install: {
      summary: 'Run any OpenAI-compatible or custom agent service, then paste its HTTP endpoint.',
      commands: [],
      endpointHint: 'Paste the custom agent backend endpoint.',
    },
    capabilities: {
      chat: true,
      tools: true,
      memory: false,
      autonomousLoop: false,
      codeExecution: false,
      multimodal: false,
    },
  },
];

function isAgentBackendId(value: unknown): value is AgentBackendId {
  return typeof value === 'string' && AGENT_BACKENDS.some((backend) => backend.id === value);
}

function getAgentBackendDefinition(id: AgentBackendId): AgentBackendDefinition {
  return AGENT_BACKENDS.find((backend) => backend.id === id) ?? AGENT_BACKENDS[0];
}

function getDefaultAgentBackendEndpoint(definition: AgentBackendDefinition): string | undefined {
  return definition.launch?.endpoint;
}

function isAgentRuntimeDeploymentTarget(value: unknown): value is AgentRuntimeDeploymentTarget {
  return value === 'local' || value === 'fly' || value === 'ecs';
}

function normalizeAvatarScope(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80) || undefined;
}

function agentRuntimeSecretKey(name: string, avatarId?: string): string {
  return avatarId ? `agent:${avatarId}:${name}` : `agent:global:${name}`;
}

function legacyAgentRuntimeSecretKey(name: string, avatarId?: string): string {
  return avatarId ? agentRuntimeSecretKey(name, avatarId) : name;
}

function runtimeSecretKey(name: string, backend: AgentBackendId, avatarId?: string): string {
  return avatarId ? `runtime:${avatarId}:${backend}:${name}` : `runtime:global:${backend}:${name}`;
}

function legacyRuntimeSecretKey(name: string, backend: AgentBackendId, avatarId?: string): string {
  return avatarId ? runtimeSecretKey(name, backend, avatarId) : `runtime-${name}:${backend}`;
}

function runtimeSupervisorKey(backend: AgentBackendId, avatarId?: string): string {
  return avatarId ? `${avatarId}:${backend}` : backend;
}

async function readFirstSecretOrNull(services: LocalServices, names: string[]): Promise<string | null> {
  for (const name of names) {
    try {
      const value = (await services.secrets.getSecret(name))?.trim();
      if (value) return value;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function localAppOrigins(port: number): Set<string> {
  return new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]);
}

export function isAllowedLocalOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return true;
  return localAppOrigins(port).has(origin);
}

function localCorsOptions(port: number): CorsOptions {
  return {
    credentials: true,
    origin(origin, callback) {
      callback(null, isAllowedLocalOrigin(origin, port));
    },
  };
}

function installLocalRequestGuard(app: express.Express, port: number): void {
  const token = process.env.SWARM_LOCAL_API_TOKEN?.trim();
  const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  app.use((req, res, next) => {
    if (!unsafeMethods.has(req.method.toUpperCase())) {
      next();
      return;
    }

    if (token && req.get('x-swarm-local-token') === token) {
      next();
      return;
    }

    const origin = req.get('origin');
    if (isAllowedLocalOrigin(origin, port)) {
      next();
      return;
    }

    res.status(403).json({ error: 'Cross-origin local API write blocked' });
  });
}

function isAllowedRuntimeLaunchCommand(backend: AgentBackendId, command: string): boolean {
  const definition = getAgentBackendDefinition(backend);
  const allowed = new Set<string>();
  if (definition.launch?.command) allowed.add(definition.launch.command);
  if (definition.launch?.docker?.command) allowed.add(definition.launch.docker.command);
  return allowed.has(command);
}

function isAuthorizedCustomRuntimeCommand(req: express.Request): boolean {
  const token = process.env.SWARM_LOCAL_API_TOKEN?.trim();
  return Boolean(
    token &&
    process.env.SWARM_LOCAL_ALLOW_CUSTOM_RUNTIME_COMMANDS === '1' &&
    req.get('x-swarm-local-token') === token,
  );
}

async function dispatchExternalAgentBackend(params: {
  status: AgentBackendStatus;
  apiKey: string | null;
  payload: ExternalBackendPayload;
}): Promise<ChatRouteResult> {
  const endpoint = params.status.endpoint?.trim();
  if (!endpoint) {
    throw new Error(`${params.status.selectedBackend.name} needs an endpoint before chat can route to it.`);
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(params.apiKey ? { Authorization: `Bearer ${params.apiKey}` } : {}),
    },
    body: JSON.stringify(params.payload),
  });

  const text = await response.text();
  let body: unknown = text;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const message = typeof body === 'object' && body && 'error' in body
      ? String((body as { error?: unknown }).error)
      : text || `HTTP ${response.status}`;
    throw new Error(`${params.status.selectedBackend.name} chat failed: ${message}`);
  }

  if (typeof body === 'string') {
    return {
      response: body,
      history: params.payload.history,
      avatar: params.payload.avatar ?? null,
    };
  }

  const result = (body ?? {}) as Partial<ChatRouteResult> & {
    message?: string;
    content?: string;
  };

  return {
    response: result.response ?? result.message ?? result.content ?? '',
    history: result.history ?? params.payload.history,
    avatar: result.avatar ?? params.payload.avatar ?? null,
    pendingToolCall: result.pendingToolCall,
    taskActions: result.taskActions,
    media: result.media,
    pendingJobs: result.pendingJobs,
    avatarUpdates: result.avatarUpdates,
  };
}

async function getLocalAgentBackendStatus(
  services: LocalServices,
  avatarId?: string,
): Promise<AgentBackendStatus> {
  let selected: AgentBackendId = 'swarm-native';
  const stored = await readFirstSecretOrNull(services, [
    agentRuntimeSecretKey('agent-backend', avatarId),
    legacyAgentRuntimeSecretKey('agent-backend', avatarId),
  ]);
  if (isAgentBackendId(stored)) {
    selected = stored;
  }

  let endpoint: string | undefined;
  let hasApiKey = false;
  let deploymentTarget: AgentRuntimeDeploymentTarget = 'local';
  endpoint = (await readFirstSecretOrNull(services, [
    agentRuntimeSecretKey('agent-backend-endpoint', avatarId),
    legacyAgentRuntimeSecretKey('agent-backend-endpoint', avatarId),
  ])) ?? undefined;
  hasApiKey = Boolean(await readFirstSecretOrNull(services, [
    agentRuntimeSecretKey('agent-backend-api-key', avatarId),
    legacyAgentRuntimeSecretKey('agent-backend-api-key', avatarId),
  ]));
  const storedTarget = await readFirstSecretOrNull(services, [
    agentRuntimeSecretKey('agent-backend-deployment-target', avatarId),
    legacyAgentRuntimeSecretKey('agent-backend-deployment-target', avatarId),
  ]);
  if (isAgentRuntimeDeploymentTarget(storedTarget)) deploymentTarget = storedTarget;

  const selectedBackend = getAgentBackendDefinition(selected);
  endpoint = endpoint || (deploymentTarget === 'local' ? getDefaultAgentBackendEndpoint(selectedBackend) : undefined);
  const configured = selectedBackend.id === 'swarm-native' ||
    selectedBackend.authMode === 'local-process' ||
    (!selectedBackend.requiresEndpoint || Boolean(endpoint));

  return {
    selected,
    selectedBackend,
    configured,
    endpoint,
    hasApiKey,
    deploymentTarget,
    scope: {
      ...(avatarId ? { avatarId } : {}),
      label: avatarId ? `Avatar ${avatarId}` : 'New agents',
    },
    backends: AGENT_BACKENDS,
  };
}

async function getLocalLlmStatus(services: LocalServices): Promise<{
  configured: boolean;
  provider: 'openrouter' | 'ollama' | null;
  selectedProvider: 'openrouter' | 'ollama' | null;
  openrouter: { configured: boolean };
  ollama: { available: boolean; model?: string; endpoint: string };
}> {
  let selectedProvider: 'openrouter' | 'ollama' | null = null;
  try {
    const rawProvider = await services.secrets.getSecret('llm-provider');
    if (rawProvider === 'openrouter' || rawProvider === 'ollama') {
      selectedProvider = rawProvider;
    }
  } catch {
    selectedProvider = null;
  }

  const envLlmKey = process.env.LLM_API_KEY;
  let hasOpenRouterKey = Boolean(
    process.env.OPENROUTER_API_KEY ||
    (envLlmKey && envLlmKey !== 'ollama')
  );
  if (!hasOpenRouterKey) {
    try {
      const key = await services.secrets.getSecret('llm-api-key');
      hasOpenRouterKey = Boolean(key?.trim());
    } catch {
      hasOpenRouterKey = false;
    }
  }

  if (hasOpenRouterKey) {
    return {
      configured: true,
      provider: 'openrouter',
      selectedProvider: 'openrouter',
      openrouter: { configured: true },
      ollama: { available: false, endpoint: getOllamaEndpoint() },
    };
  }

  const model = await getOllamaModel();
  const ollamaAvailable = Boolean(model) || await isOllamaAvailable();
  if (model) {
    process.env.LLM_ENDPOINT = getOllamaEndpoint();
    process.env.LLM_API_KEY = 'ollama';
    process.env.LLM_MODEL = model;
  }

  return {
    configured: selectedProvider === 'ollama' && Boolean(model),
    provider: selectedProvider === 'ollama' && model ? 'ollama' : null,
    selectedProvider,
    openrouter: { configured: false },
    ollama: { available: ollamaAvailable, model, endpoint: getOllamaEndpoint() },
  };
}

export async function mountAdminRoutes(
  app: express.Express,
  services: LocalServices,
  processChatOverride?: ChatProcessor,
) {
  const { processChat } = await import(
    '../../admin-api/src/handlers/chat.js'
  );
  const chat = processChatOverride ?? (processChat as unknown as ChatProcessor);

  // ── Runtime supervisor (launch/stop external agent backends) ────────
  const supervisor = new RuntimeSupervisor();
  const stopSupervised = () => supervisor.stopAll();
  process.once('exit', stopSupervised);
  process.once('SIGINT', stopSupervised);
  process.once('SIGTERM', stopSupervised);

  const makeLocalSession = (sessionOverride?: { email?: string; userId?: string; isAdmin?: boolean }): LocalSession => ({
    email: sessionOverride?.email ?? 'local@swarm.dev',
    userId: sessionOverride?.userId ?? 'local-user',
    isAdmin: sessionOverride?.isAdmin ?? true,
    accessToken: 'local',
  });

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

      const session = makeLocalSession(sessionOverride);
      const avatarScope = normalizeAvatarScope(avatar?.id);
      const backendStatus = await getLocalAgentBackendStatus(services, avatarScope);

      const result = backendStatus.selected === 'swarm-native'
        ? await (async () => {
            const llmStatus = await getLocalLlmStatus(services);
            if (!llmStatus.configured) {
              res.status(409).json({
                error: 'AI provider setup required',
                code: 'AI_PROVIDER_REQUIRED',
                message: 'Connect OpenRouter or start Ollama before chatting.',
                providerStatus: llmStatus,
              });
              return null;
            }
            return chat(
              message ?? null,
              history,
              session,
              avatar ? { id: avatar.id } : undefined,
            );
          })()
        : await (async () => {
            if (!backendStatus.configured || !backendStatus.endpoint) {
              res.status(409).json({
                error: 'Agent backend setup required',
                code: 'AGENT_BACKEND_REQUIRED',
                message: `Configure or launch ${backendStatus.selectedBackend.name} before chatting.`,
                backendStatus,
              });
              return null;
            }
            const apiKey = await readFirstSecretOrNull(services, [
              agentRuntimeSecretKey('agent-backend-api-key', avatarScope),
              legacyAgentRuntimeSecretKey('agent-backend-api-key', avatarScope),
            ]);
            return dispatchExternalAgentBackend({
              status: backendStatus,
              apiKey,
              payload: {
                message: message ?? null,
                history,
                session,
                avatar: avatar ? { id: avatar.id } : undefined,
                backend: backendStatus.selected,
              },
            });
          })();

      if (!result) return;

      // Persist pending tool call so the tools resume endpoint can validate it
      const pendingToolCall = result.pendingToolCall;
      if (pendingToolCall && avatar?.id) {
        try {
          const { savePendingTool } = await import(
            "../../admin-api/src/services/pending-tools.js"
          );
          await savePendingTool({
            email: session.email,
            avatarId: avatar.id,
            toolCallId: pendingToolCall.id,
            toolName: pendingToolCall.name,
            arguments: pendingToolCall.arguments,
          });
          console.log(`[local] Persisted pending tool call ${pendingToolCall.id}`);
        } catch (e) {
          console.error("[local] Failed to persist pending tool:", e);
        }
      }

      res.json({
        response: result.response,
        history: result.history,
        avatar: result.avatar,
        pendingToolCall,
        taskActions: result.taskActions,
        media: result.media,
        pendingJobs: result.pendingJobs,
        avatarUpdates: result.avatarUpdates,
      });
    } catch (err) {
      console.error('[local] Chat error:', err);
      res.status(500).json({
        error: 'Chat processing failed',
        detail: (err as Error).message,
      });
    }
  });

  app.get('/api/chat', async (req, res) => {
    try {
      const { getChatHistory } = await import('../../admin-api/src/services/chat-history.js');
      const avatarId = typeof req.query.avatarId === 'string' ? req.query.avatarId : undefined;
      const history = await getChatHistory(makeLocalSession(), avatarId);
      res.json({ history });
    } catch (err) {
      console.error('[local] Chat history load error:', err);
      res.status(500).json({ error: 'Failed to load chat history' });
    }
  });

  app.delete('/api/chat', async (req, res) => {
    try {
      const { clearChatHistory } = await import('../../admin-api/src/services/chat-history.js');
      const avatarId = typeof req.query.avatarId === 'string' ? req.query.avatarId : undefined;
      await clearChatHistory(makeLocalSession(), avatarId);
      res.json({ success: true });
    } catch (err) {
      console.error('[local] Chat history clear error:', err);
      res.status(500).json({ error: 'Failed to clear chat history' });
    }
  });

  app.post('/api/chat/message', async (req, res) => {
    try {
      const { appendSystemMessage } = await import('../../admin-api/src/services/chat-history.js');
      const { avatarId, message } = req.body as {
        avatarId?: string;
        message?: { role?: 'assistant' | 'user'; content?: string };
      };
      if (!avatarId || !message?.role || !message.content) {
        res.status(400).json({ error: 'avatarId and message required' });
        return;
      }
      const history = await appendSystemMessage(makeLocalSession(), avatarId, {
        role: message.role,
        content: message.content,
      });
      res.json({ history });
    } catch (err) {
      console.error('[local] Chat history append error:', err);
      res.status(500).json({ error: 'Failed to append chat message' });
    }
  });

  app.get('/api/llm/status', async (_req, res) => {
    res.json(await getLocalLlmStatus(services));
  });

  app.post('/api/llm/provider', async (req, res) => {
    const { provider } = req.body as { provider?: string };
    if (provider !== 'openrouter' && provider !== 'ollama') {
      res.status(400).json({ error: 'provider must be openrouter or ollama' });
      return;
    }

    await services.secrets.setSecret('llm-provider', provider);
    await services.secrets.flush();
    res.json(await getLocalLlmStatus(services));
  });

  app.delete('/api/llm/provider', async (_req, res) => {
    await services.secrets.deleteSecret('llm-provider').catch(() => undefined);
    await services.secrets.deleteSecret('llm-api-key').catch(() => undefined);
    await services.secrets.flush();
    res.json(await getLocalLlmStatus(services));
  });

  app.get('/api/agent-backends', async (req, res) => {
    const avatarId = normalizeAvatarScope(req.query.avatarId);
    res.json(await getLocalAgentBackendStatus(services, avatarId));
  });

  app.post('/api/agent-backends/select', async (req, res) => {
    const { backend, endpoint, apiKey, avatarId, deploymentTarget } = req.body as {
      backend?: unknown;
      endpoint?: unknown;
      apiKey?: unknown;
      avatarId?: unknown;
      deploymentTarget?: unknown;
    };

    if (!isAgentBackendId(backend)) {
      res.status(400).json({ error: 'backend must be a supported agent backend id' });
      return;
    }
    if (deploymentTarget !== undefined && !isAgentRuntimeDeploymentTarget(deploymentTarget)) {
      res.status(400).json({ error: 'deploymentTarget must be local, fly, or ecs' });
      return;
    }

    const definition = getAgentBackendDefinition(backend);
    const target = deploymentTarget ?? 'local';
    const scopedAvatarId = normalizeAvatarScope(avatarId);
    const defaultEndpoint = target === 'local' ? getDefaultAgentBackendEndpoint(definition) ?? '' : '';
    const providedEndpoint = typeof endpoint === 'string' ? endpoint.trim() : '';
    const trimmedEndpoint = providedEndpoint || defaultEndpoint;
    const trimmedApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';

    if (target === 'ecs') {
      res.status(400).json({ error: 'ECS runtimes are not available yet' });
      return;
    }
    if (definition.requiresEndpoint && !trimmedEndpoint) {
      res.status(400).json({ error: `${definition.name} requires an endpoint` });
      return;
    }

    await services.secrets.setSecret(agentRuntimeSecretKey('agent-backend', scopedAvatarId), backend);
    await services.secrets.setSecret(agentRuntimeSecretKey('agent-backend-deployment-target', scopedAvatarId), target);
    if (trimmedEndpoint) {
      await services.secrets.setSecret(agentRuntimeSecretKey('agent-backend-endpoint', scopedAvatarId), trimmedEndpoint);
    } else {
      await services.secrets.deleteSecret(agentRuntimeSecretKey('agent-backend-endpoint', scopedAvatarId)).catch(() => undefined);
    }
    if (definition.authMode !== 'api-key' && definition.authMode !== 'oauth') {
      await services.secrets.deleteSecret(agentRuntimeSecretKey('agent-backend-api-key', scopedAvatarId)).catch(() => undefined);
    } else if (trimmedApiKey) {
      await services.secrets.setSecret(agentRuntimeSecretKey('agent-backend-api-key', scopedAvatarId), trimmedApiKey);
    }
    await services.secrets.flush();
    res.json(await getLocalAgentBackendStatus(services, scopedAvatarId));
  });

  app.delete('/api/agent-backends/select', async (req, res) => {
    const avatarId = normalizeAvatarScope(req.query.avatarId);
    await services.secrets.deleteSecret(agentRuntimeSecretKey('agent-backend', avatarId)).catch(() => undefined);
    await services.secrets.deleteSecret(agentRuntimeSecretKey('agent-backend-endpoint', avatarId)).catch(() => undefined);
    await services.secrets.deleteSecret(agentRuntimeSecretKey('agent-backend-api-key', avatarId)).catch(() => undefined);
    await services.secrets.deleteSecret(agentRuntimeSecretKey('agent-backend-deployment-target', avatarId)).catch(() => undefined);
    await services.secrets.flush();
    res.json(await getLocalAgentBackendStatus(services, avatarId));
  });

  // ── Runtime supervisor: launch/stop external agent backends ─────────
  const runtimeStatePayload = async (backend: AgentBackendId, avatarId?: string) => {
    const definition = getAgentBackendDefinition(backend);
    const runtimeKey = runtimeSupervisorKey(backend, avatarId);
    const live = supervisor.status(runtimeKey);
    const command =
      live.command ??
      (await readFirstSecretOrNull(services, [
        runtimeSecretKey('launch', backend, avatarId),
        legacyRuntimeSecretKey('launch', backend, avatarId),
      ])) ??
      definition.launch?.command ??
      '';
    const endpoint =
      live.endpoint ??
      (await readFirstSecretOrNull(services, [
        runtimeSecretKey('endpoint', backend, avatarId),
        legacyRuntimeSecretKey('endpoint', backend, avatarId),
      ])) ??
      definition.launch?.endpoint ??
      '';
    return { ...live, backend, command, endpoint, supported: process.platform !== 'win32' };
  };

  app.get('/api/runtime/status', async (req, res) => {
    const backend = req.query.backend;
    const avatarId = normalizeAvatarScope(req.query.avatarId);
    if (!isAgentBackendId(backend)) {
      res.status(400).json({ error: 'backend query param required' });
      return;
    }
    res.json(await runtimeStatePayload(backend, avatarId));
  });

  app.get('/api/runtime/logs', (req, res) => {
    const backend = req.query.backend;
    const avatarId = normalizeAvatarScope(req.query.avatarId);
    if (!isAgentBackendId(backend)) {
      res.status(400).json({ error: 'backend query param required' });
      return;
    }
    res.json({ logs: supervisor.logs(runtimeSupervisorKey(backend, avatarId)) });
  });

  app.post('/api/runtime/start', async (req, res) => {
    try {
      const { backend, command, endpoint, avatarId } = req.body as {
        backend?: unknown;
        command?: unknown;
        endpoint?: unknown;
        avatarId?: unknown;
      };
      if (!isAgentBackendId(backend)) {
        res.status(400).json({ error: 'backend must be a supported agent backend id' });
        return;
      }
      const cmd = typeof command === 'string' ? command.trim() : '';
      if (!cmd) {
        res.status(400).json({ error: 'launch command required' });
        return;
      }
      if (!isAllowedRuntimeLaunchCommand(backend, cmd) && !isAuthorizedCustomRuntimeCommand(req)) {
        res.status(400).json({ error: 'Launch command must match a known runtime template' });
        return;
      }
      const ep = typeof endpoint === 'string' ? endpoint.trim() : '';
      const scopedAvatarId = normalizeAvatarScope(avatarId);
      await services.secrets.setSecret(runtimeSecretKey('launch', backend, scopedAvatarId), cmd);
      if (ep) await services.secrets.setSecret(runtimeSecretKey('endpoint', backend, scopedAvatarId), ep);
      await services.secrets.flush();
      supervisor.start(runtimeSupervisorKey(backend, scopedAvatarId), cmd, ep || null);
      res.json(await runtimeStatePayload(backend, scopedAvatarId));
    } catch (err) {
      console.error('[local] runtime start error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/runtime/stop', async (req, res) => {
    const { backend, avatarId } = req.body as { backend?: unknown; avatarId?: unknown };
    if (!isAgentBackendId(backend)) {
      res.status(400).json({ error: 'backend must be a supported agent backend id' });
      return;
    }
    const scopedAvatarId = normalizeAvatarScope(avatarId);
    await supervisor.stopAndWait(runtimeSupervisorKey(backend, scopedAvatarId));
    res.json(await runtimeStatePayload(backend, scopedAvatarId));
  });

  app.post('/api/runtime/restart', async (req, res) => {
    try {
      const { backend, command, endpoint, avatarId } = req.body as {
        backend?: unknown;
        command?: unknown;
        endpoint?: unknown;
        avatarId?: unknown;
      };
      if (!isAgentBackendId(backend)) {
        res.status(400).json({ error: 'backend must be a supported agent backend id' });
        return;
      }
      const scopedAvatarId = normalizeAvatarScope(avatarId);
      const current = await runtimeStatePayload(backend, scopedAvatarId);
      await supervisor.stopAndWait(runtimeSupervisorKey(backend, scopedAvatarId));
      const cmd = (typeof command === 'string' && command.trim()) || current.command;
      const ep = (typeof endpoint === 'string' && endpoint.trim()) || current.endpoint;
      if (cmd) {
        if (!isAllowedRuntimeLaunchCommand(backend, cmd) && !isAuthorizedCustomRuntimeCommand(req)) {
          res.status(400).json({ error: 'Launch command must match a known runtime template' });
          return;
        }
        await services.secrets.setSecret(runtimeSecretKey('launch', backend, scopedAvatarId), cmd);
        if (ep) await services.secrets.setSecret(runtimeSecretKey('endpoint', backend, scopedAvatarId), ep);
        await services.secrets.flush();
        supervisor.start(runtimeSupervisorKey(backend, scopedAvatarId), cmd, ep || null);
      }
      res.json(await runtimeStatePayload(backend, scopedAvatarId));
    } catch (err) {
      console.error('[local] runtime restart error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Reset a backend's launch command/endpoint back to the built-in default.
  app.delete('/api/runtime/launch', async (req, res) => {
    const backend = req.query.backend;
    const avatarId = normalizeAvatarScope(req.query.avatarId);
    if (!isAgentBackendId(backend)) {
      res.status(400).json({ error: 'backend query param required' });
      return;
    }
    await services.secrets.deleteSecret(runtimeSecretKey('launch', backend, avatarId)).catch(() => undefined);
    await services.secrets.deleteSecret(runtimeSecretKey('endpoint', backend, avatarId)).catch(() => undefined);
    await services.secrets.flush();
    res.json(await runtimeStatePayload(backend, avatarId));
  });

  // Open the user's terminal to run a known install command (visible, allows sudo prompts).
  app.post('/api/runtime/open-terminal', (req, res) => {
    const { command } = req.body as { command?: unknown };
    if (typeof command !== 'string' || !command.trim()) {
      res.status(400).json({ error: 'command required' });
      return;
    }
    const known = new Set(AGENT_BACKENDS.flatMap((b) => b.install.commands));
    if (!known.has(command)) {
      res.status(400).json({ error: 'Unrecognized install command' });
      return;
    }
    if (process.platform !== 'darwin') {
      res.status(501).json({ error: `Run-in-terminal is only supported on macOS right now (platform: ${process.platform}).` });
      return;
    }
    const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `tell application "Terminal"\n  activate\n  do script "${escaped}"\nend tell`;
    execFile('osascript', ['-e', script], (err) => {
      if (err) {
        console.error('[local] open-terminal error:', err);
        res.status(500).json({ error: err.message });
        return;
      }
      res.json({ success: true });
    });
  });

  app.get('/api/avatars', async (_req, res) => {
    try {
      const { listAvatars } = await import(
        '../../admin-api/src/services/avatars.js'
      );
      const avatars = await listAvatars();
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
      const session = localAdminSession();
      const { name, description } = req.body as { name?: string; description?: string };
      if (!name) { res.status(400).json({ error: "name required" }); return; }
      const avatar = await createAvatar(name, session, description);
      _signalState.latestAvatarId = avatar.avatarId;
      _signalState.latestPubkey = avatar.identity?.pubkey || null;
      _signalState.latestIdentity = avatar.identity || null;
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
      await services.secrets.setSecret(secretName, value);
      await services.secrets.flush();
      console.log(`[local] Secret ${secretName} saved successfully`);
      res.json({ success: true, message: `${key} stored securely` });
    } catch (err) {
      console.error(`[local] Secret save error for ${req.params.id}:`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/avatars/:id/secrets", async (_req, res) => {
    try {
      const names = await services.secrets.listSecrets();
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

  app.post("/api/avatars/:id/validate-ai-key", async (_req, res) => {
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
      const session = localAdminSession();
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
      const session = localAdminSession();
      const result = await updateAvatar(req.params.id, req.body, session);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/avatars/:id/activate", async (req, res) => {
    try {
      const { activateAvatar } = await import("../../admin-api/src/services/avatars.js");
      const session = localAdminSession();
      const result = await activateAvatar(req.params.id, session.userId);
      if (!result.success) {
        res.status(400).json({ error: result.error ?? "Failed to activate avatar" });
        return;
      }
      console.log(`[local] Activated avatar ${req.params.id}`);
      res.json({ success: true, status: "active" });
    } catch (err) {
      console.error(`[local] Activate error for ${req.params.id}:`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/avatars/:id/deactivate", async (req, res) => {
    try {
      const { deactivateAvatar } = await import("../../admin-api/src/services/avatars.js");
      const session = localAdminSession();
      const result = await deactivateAvatar(req.params.id, session.userId);
      if (!result.success) {
        res.status(400).json({ error: result.error ?? "Failed to deactivate avatar" });
        return;
      }
      console.log(`[local] Deactivated avatar ${req.params.id}`);
      res.json({ success: true, status: "paused" });
    } catch (err) {
      console.error(`[local] Deactivate error for ${req.params.id}:`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/avatars/:id/integrations", async (_req, res) => {
    res.json({ integrations: {} });  // local mode: no integrations configured yet
  });

  app.post("/api/avatars/:id/integrations", async (req, res) => {
    try {
      const { updateAvatar } = await import("../../admin-api/src/services/avatars.js");
      const session = localAdminSession();
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
      const avatar = await getAvatar(req.params.id);
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
      const session = localAdminSession();
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
