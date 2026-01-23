#!/usr/bin/env node
/**
 * Bulk repair Telegram webhooks safely.
 *
 * Default behavior is DRY RUN: it only reports what would change.
 * To actually repair mismatches, pass: --apply --yes
 *
 * Auth: uses INTERNAL_TEST_KEY bypass (direct API Gateway only).
 *
 * Required env vars (recommended):
 *   SWARM_ADMIN_API_URL=https://xxxx.execute-api.us-east-1.amazonaws.com
 *   SWARM_INTERNAL_TEST_KEY=...
 *
 * Example:
 *   SWARM_ADMIN_API_URL=... SWARM_INTERNAL_TEST_KEY=... node scripts/repair-telegram-webhooks.mjs --dry-run
 *   SWARM_ADMIN_API_URL=... SWARM_INTERNAL_TEST_KEY=... node scripts/repair-telegram-webhooks.mjs --apply --yes
 */

const DEFAULT_CONCURRENCY = 5;

function parseArgs(argv) {
  const args = {
    dryRun: true,
    apply: false,
    yes: false,
    concurrency: DEFAULT_CONCURRENCY,
    limit: undefined,
    only: undefined,
    force: false,
    includeDisabled: false,
    rotateSecret: false,
    repairOnPendingUpdates: false,
    repairOnLastError: false,
    baseUrl: process.env.SWARM_ADMIN_API_URL || process.env.API_URL || '',
    internalTestKey: process.env.SWARM_INTERNAL_TEST_KEY || process.env.INTERNAL_TEST_KEY || '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--apply') args.apply = true;
    else if (a === '--yes') args.yes = true;
    else if (a === '--force') args.force = true;
    else if (a === '--include-disabled') args.includeDisabled = true;
    else if (a === '--rotate-secret') args.rotateSecret = true;
    else if (a === '--repair-on-pending-updates') args.repairOnPendingUpdates = true;
    else if (a === '--repair-on-last-error') args.repairOnLastError = true;
    else if (a === '--base-url') args.baseUrl = argv[++i] || '';
    else if (a === '--internal-test-key') args.internalTestKey = argv[++i] || '';
    else if (a === '--concurrency') args.concurrency = Number.parseInt(argv[++i] || '', 10);
    else if (a === '--limit') args.limit = Number.parseInt(argv[++i] || '', 10);
    else if (a === '--only') args.only = (argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      // ignore unknown
    }
  }

  return args;
}

function usage() {
  console.log(`\nUsage:\n  node scripts/repair-telegram-webhooks.mjs [options]\n\nOptions:\n  --dry-run                     Report only (default)\n  --apply --yes                 Actually call repair endpoint\n  --only a,b,c                  Only process these avatar IDs\n  --limit N                     Limit number of avatars processed\n  --concurrency N               Parallelism (default ${DEFAULT_CONCURRENCY})\n  --force                       Repair even if already correct\n  --include-disabled            Allow repair even if telegram is disabled\n  --rotate-secret               Rotate telegram_webhook_secret (not recommended)\n  --repair-on-pending-updates   Repair when Telegram reports pending updates\n  --repair-on-last-error        Repair when Telegram reports last error\n  --base-url URL                Override Admin API base URL\n  --internal-test-key KEY       Override internal test key\n\nEnv vars:\n  SWARM_ADMIN_API_URL, SWARM_INTERNAL_TEST_KEY\n\nExample (dry run):\n  SWARM_ADMIN_API_URL=... SWARM_INTERNAL_TEST_KEY=... node scripts/repair-telegram-webhooks.mjs\n\nExample (apply):\n  SWARM_ADMIN_API_URL=... SWARM_INTERNAL_TEST_KEY=... node scripts/repair-telegram-webhooks.mjs --apply --yes\n`);
}

async function httpJson(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (true) {
      const i = index;
      index += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

function toAvatarId(a) {
  return a?.avatarId || a?.id || a?.name || null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }

  const baseUrl = (args.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl) {
    console.error('Missing Admin API URL. Set SWARM_ADMIN_API_URL or pass --base-url');
    process.exit(1);
  }
  if (!args.internalTestKey) {
    console.error('Missing internal test key. Set SWARM_INTERNAL_TEST_KEY or pass --internal-test-key');
    process.exit(1);
  }

  const shouldApply = Boolean(args.apply && args.yes);
  const dryRun = shouldApply ? false : true;

  if (args.apply && !args.yes) {
    console.warn('Refusing to apply without --yes; running as dry-run.');
  }

  const headers = { 'x-internal-test-key': args.internalTestKey };

  console.log(`[telegram-repair] baseUrl=${baseUrl}`);
  console.log(`[telegram-repair] mode=${dryRun ? 'dry-run' : 'apply'}`);

  const avatars = await httpJson(`${baseUrl}/avatars`, { headers });
  const list = Array.isArray(avatars) ? avatars : (avatars?.avatars || avatars?.items || []);

  let avatarIds = list.map(toAvatarId).filter(Boolean);
  if (args.only?.length) {
    const allow = new Set(args.only);
    avatarIds = avatarIds.filter(id => allow.has(id));
  }
  if (Number.isFinite(args.limit) && args.limit > 0) {
    avatarIds = avatarIds.slice(0, args.limit);
  }

  console.log(`[telegram-repair] avatars=${avatarIds.length}`);

  const bodyTemplate = {
    dryRun,
    force: args.force,
    includeDisabled: args.includeDisabled,
    rotateSecret: args.rotateSecret,
    repairOnPendingUpdates: args.repairOnPendingUpdates,
    repairOnLastError: args.repairOnLastError,
  };

  const results = await mapPool(avatarIds, args.concurrency, async (avatarId) => {
    const url = `${baseUrl}/avatars/${encodeURIComponent(avatarId)}/telegram/repair`;
    try {
      const res = await httpJson(url, {
        method: 'POST',
        headers,
        body: bodyTemplate,
      });
      return { avatarId, ok: true, action: res?.action, reason: res?.reason };
    } catch (err) {
      return {
        avatarId,
        ok: false,
        error: err?.message || String(err),
        status: err?.status,
        data: err?.data,
      };
    }
  });

  const summary = {
    repaired: 0,
    wouldRepair: 0,
    skipped: 0,
    errors: 0,
  };

  for (const r of results) {
    if (!r.ok) {
      summary.errors += 1;
      console.error(`[telegram-repair] ERROR avatar=${r.avatarId} ${r.status || ''} ${r.error}`);
      continue;
    }

    if (r.action === 'repaired') summary.repaired += 1;
    else if (r.action === 'would_repair') summary.wouldRepair += 1;
    else if (r.action === 'skipped') summary.skipped += 1;

    const line = `[telegram-repair] ${r.action?.toUpperCase() || 'OK'} avatar=${r.avatarId}${r.reason ? ` reason=${r.reason}` : ''}`;
    console.log(line);
  }

  console.log(`\n[telegram-repair] summary=${JSON.stringify(summary)}`);

  if (summary.errors > 0) {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error('[telegram-repair] fatal:', err);
  process.exit(1);
});
