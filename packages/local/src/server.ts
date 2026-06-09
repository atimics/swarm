/**
 * Local HTTP server — runs the swarm admin API and serves the admin UI.
 */
import express from 'express';
import cors from 'cors';
import { createInterface } from 'readline';
import { randomBytes, createHash } from "crypto";
import { startTelegramPolling } from "./telegram-polling.js";
import { isOllamaAvailable, getOllamaModel, getOllamaEndpoint } from "./llm-ollama.js";
import { getRatiBalance, getSolBalance } from "./rati-auto-bridge.js";
import { createLocalServices } from './factories.js';
import { LocalS3Adapter } from './s3-adapter.js';
import { LocalSQSAdapter } from './sqs-adapter.js';
import { LocalSecretsAdapter } from './secrets-adapter.js';
import { LocalLambdaAdapter } from './lambda-adapter.js';

export { createLocalServices } from './factories.js';

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
        const session = { email: "local@swarm.dev", userId: "local-user", isAdmin: true };
        const avatars = await listAvatars(session);
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
      server.on("error", reject);
    },
  );
}

// ── Route mounting ──────────────────────────────────────────────────────

type ChatHistoryMessage = { role: string; content: string; [key: string]: unknown };
type LocalSession = { email: string; userId: string; isAdmin: boolean };
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

export async function mountAdminRoutes(
  app: express.Express,
  _services: ReturnType<typeof createLocalServices>,
  processChatOverride?: ChatProcessor,
) {
  const { processChat } = await import(
    '../../admin-api/src/handlers/chat.js'
  );
  const chat = processChatOverride ?? (processChat as unknown as ChatProcessor);

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
        history,
        session,
        avatar ? { id: avatar.id } : undefined,
      );

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
