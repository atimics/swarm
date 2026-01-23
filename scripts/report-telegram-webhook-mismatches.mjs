#!/usr/bin/env node
/**
 * Report how many Telegram-enabled avatars have a webhook URL mismatch.
 *
 * This script does NOT change anything.
 * It:
 *  - fetches avatars via Admin API (/avatars)
 *  - reads Telegram bot token from AWS Secrets Manager
 *  - calls Telegram getWebhookInfo
 *  - compares webhook URL vs expected
 *
 * Required env vars:
 *   SWARM_ADMIN_API_URL=https://xxxx.execute-api....amazonaws.com
 *   SWARM_INTERNAL_TEST_KEY=...
 *
 * Optional env vars:
 *   AWS_REGION=us-east-1
 *
 * Options:
 *   --expected-domain staging-swarm.rati.chat
 *   --secret-prefix swarm
 *   --only a,b,c
 *   --concurrency 3
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_CONCURRENCY = 3;

function parseArgs(argv) {
  const args = {
    expectedDomain: 'staging-swarm.rati.chat',
    secretPrefix: 'swarm',
    concurrency: DEFAULT_CONCURRENCY,
    only: undefined,
    baseUrl: process.env.SWARM_ADMIN_API_URL || process.env.API_URL || '',
    internalTestKey: process.env.SWARM_INTERNAL_TEST_KEY || process.env.INTERNAL_TEST_KEY || '',
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--expected-domain') args.expectedDomain = argv[++i] || args.expectedDomain;
    else if (a === '--secret-prefix') args.secretPrefix = argv[++i] || args.secretPrefix;
    else if (a === '--concurrency') args.concurrency = Number.parseInt(argv[++i] || '', 10);
    else if (a === '--only') args.only = (argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--help' || a === '-h') args.help = true;
  }

  return args;
}

function usage() {
  console.log(`\nUsage:\n  node scripts/report-telegram-webhook-mismatches.mjs [options]\n\nOptions:\n  --expected-domain DOMAIN      Default: staging-swarm.rati.chat\n  --secret-prefix PREFIX        Default: swarm\n  --only a,b,c                  Only process these avatar IDs\n  --concurrency N               Default: ${DEFAULT_CONCURRENCY}\n\nEnv vars:\n  SWARM_ADMIN_API_URL, SWARM_INTERNAL_TEST_KEY, AWS_REGION\n`);
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

function expectedWebhookUrl(expectedDomain, avatarId) {
  return `https://${expectedDomain}/webhook/telegram/${avatarId}`;
}

async function getTelegramWebhookInfo(botToken) {
  const url = `https://api.telegram.org/bot${botToken}/getWebhookInfo`;
  const res = await fetch(url);
  const json = await res.json();
  if (!json?.ok) {
    const desc = json?.description ? String(json.description) : 'Telegram API error';
    throw new Error(desc);
  }
  return json.result || {};
}

async function getSecretStringAwsCli(secretId, region) {
  try {
    const { stdout } = await execFileAsync(
      'aws',
      [
        'secretsmanager',
        'get-secret-value',
        '--secret-id',
        secretId,
        '--region',
        region,
        '--query',
        'SecretString',
        '--output',
        'text',
      ],
      { maxBuffer: 5 * 1024 * 1024 }
    );
    const value = String(stdout ?? '').trim();
    return value || null;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }

  const baseUrl = (args.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl) {
    console.error('Missing Admin API URL. Set SWARM_ADMIN_API_URL');
    process.exit(1);
  }
  if (!args.internalTestKey) {
    console.error('Missing internal test key. Set SWARM_INTERNAL_TEST_KEY');
    process.exit(1);
  }

  const headers = { 'x-internal-test-key': args.internalTestKey };
  const avatarsRes = await httpJson(`${baseUrl}/avatars`, { headers });
  const avatars = Array.isArray(avatarsRes) ? avatarsRes : (avatarsRes?.avatars || avatarsRes?.items || []);

  const telegramEnabled = avatars
    .filter(a => a?.platforms?.telegram?.enabled)
    .map(a => a.avatarId)
    .filter(Boolean);

  const avatarIds = args.only?.length
    ? telegramEnabled.filter(id => new Set(args.only).has(id))
    : telegramEnabled;

  console.log(`[telegram-webhook-report] totalAvatars=${avatars.length}`);
  console.log(`[telegram-webhook-report] telegramEnabled=${telegramEnabled.length}`);
  console.log(`[telegram-webhook-report] checking=${avatarIds.length}`);

  const results = await mapPool(avatarIds, args.concurrency, async (avatarId) => {
    const secretId = `${args.secretPrefix}/${avatarId}/telegram_bot_token/default`;

    const botToken = await getSecretStringAwsCli(secretId, args.region);
    if (!botToken) {
      return { avatarId, ok: false, error: 'missing_bot_token_secret' };
    }

    try {
      const info = await getTelegramWebhookInfo(botToken);
      const expected = expectedWebhookUrl(args.expectedDomain, avatarId);
      const actual = info.url || '';
      const isMatch = !actual || actual === expected;
      return {
        avatarId,
        ok: true,
        expected,
        actual,
        isMatch,
        pending: info.pending_update_count || 0,
        lastError: info.last_error_message || undefined,
        lastErrorDate: info.last_error_date || undefined,
      };
    } catch (e) {
      return {
        avatarId,
        ok: false,
        error: 'telegram_api_error',
        message: e instanceof Error ? e.message : String(e),
      };
    }
  });

  const summary = {
    checked: results.length,
    missingToken: 0,
    telegramErrors: 0,
    matches: 0,
    mismatches: 0,
  };

  for (const r of results) {
    if (!r.ok) {
      if (r.error === 'missing_bot_token_secret' || r.error === 'empty_bot_token_secret') summary.missingToken += 1;
      else summary.telegramErrors += 1;
      console.log(
        `[telegram-webhook-report] ERROR avatar=${r.avatarId} error=${r.error}${r.message ? ` msg=${r.message}` : ''}`
      );
      continue;
    }

    if (r.isMatch) {
      summary.matches += 1;
      console.log(`[telegram-webhook-report] OK avatar=${r.avatarId} pending=${r.pending}`);
    } else {
      summary.mismatches += 1;
      console.log(`[telegram-webhook-report] MISMATCH avatar=${r.avatarId} actual=${r.actual} expected=${r.expected}`);
    }

    if (r.lastError) {
      const when = r.lastErrorDate ? new Date(r.lastErrorDate * 1000).toISOString() : 'unknown';
      console.log(`[telegram-webhook-report] LAST_ERROR avatar=${r.avatarId} at=${when} msg=${r.lastError}`);
    }
  }

  console.log(`\n[telegram-webhook-report] summary=${JSON.stringify(summary)}`);
}

main().catch((err) => {
  console.error('[telegram-webhook-report] fatal:', err?.message || err);
  process.exit(1);
});
