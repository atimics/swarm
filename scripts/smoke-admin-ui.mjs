import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';

const shouldSkip = ['1', 'true', 'yes'].includes(String(process.env.SKIP_UI_SMOKE || '').toLowerCase());
if (shouldSkip) {
  console.log('smoke-admin-ui: SKIP_UI_SMOKE set; skipping');
  process.exit(0);
}

const PORT = process.env.SMOKE_UI_PORT || '4173';
const URL = `http://localhost:${PORT}`;

async function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (res.ok) return;
    } catch {
      // ignore until server is up
    }
    await delay(500);
  }
  throw new Error(`Admin UI preview did not become ready within ${timeoutMs}ms at ${url}`);
}

async function runSmoke() {
  const preview = spawn(
    'pnpm',
    ['--filter', '@swarm/admin-ui', 'preview', '--', '--port', PORT, '--strictPort'],
    {
      stdio: 'inherit',
      env: process.env,
    }
  );

  try {
    await waitForServer(URL);

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const errors = [];

    const allowedErrorPatterns = [
      /\[WalletAuth\] Check auth error: SyntaxError: Unexpected token '<'/i,
      /Failed to fetch/i,
    ];

    page.on('pageerror', (err) => {
      errors.push(err?.message || String(err));
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await page.goto(URL, { waitUntil: 'networkidle' });

    const bodyText = await page.textContent('body');
    if (bodyText && bodyText.includes('Privy is not configured')) {
      throw new Error('Privy is not configured. Set VITE_PRIVY_APP_ID in packages/admin-ui/.env.');
    }

    const filtered = errors.filter(
      (message) => !allowedErrorPatterns.some((pattern) => pattern.test(message))
    );
    if (filtered.length > 0) {
      throw new Error(`Admin UI console errors:\n- ${filtered.join('\n- ')}`);
    }

    await browser.close();
  } finally {
    preview.kill('SIGTERM');
  }
}

runSmoke().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
