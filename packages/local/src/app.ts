/**
 * Swarm Desktop — macOS application entry point.
 *
 * Starts the server with native osascript password dialogs (or
 * stdin prompts when running in a terminal). Opens the admin UI
 * in the default browser once the server is ready.
 */
import { execSync } from 'child_process';
import { mkdirSync } from 'fs';
import { startServer } from './server.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOME = process.env.HOME ?? '/tmp';
const DB_PATH = process.env.SWARM_DB_PATH ?? `${HOME}/Library/Application Support/Swarm/swarm.db`;
const BLOB_DIR = process.env.SWARM_BLOB_DIR ?? `${HOME}/Library/Application Support/Swarm/blobs`;

mkdirSync(DB_PATH.replace(/\/[^/]+$/, ''), { recursive: true });
mkdirSync(BLOB_DIR, { recursive: true });

// ── Native dialog prompt ───────────────────────────────────────────────

function nativePrompt(message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const escaped = message.replace(/"/g, '\\"');
      const result = execSync(
        `osascript -e 'tell app "System Events" to display dialog "${escaped}" default answer "" with hidden answer with title "Swarm" buttons {"OK"} default button "OK" with icon note' -e 'text returned of result'`,
        { encoding: 'utf8', timeout: 300_000 },
      ).trim();
      if (result) resolve(result);
      else reject(new Error('No input'));
    } catch (err) {
      reject(err);
    }
  });
}

// ── Main ───────────────────────────────────────────────────────────────

console.log('🐝 Swarm Desktop starting...');

const { app, services } = await startServer({
  port: PORT,
  dbPath: DB_PATH,
  blobDir: BLOB_DIR,
  promptFn: nativePrompt,
});

const url = `http://localhost:${PORT}`;
try {
  execSync(`open "${url}"`);
  console.log(`   Opened ${url}`);
} catch {
  console.log(`   Server running at ${url}`);
}

console.log('✅ Swarm Desktop is running.');

process.on('SIGINT', () => { services.shutdown(); process.exit(0); });
process.on('SIGTERM', () => { services.shutdown(); process.exit(0); });
