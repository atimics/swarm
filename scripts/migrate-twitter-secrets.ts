#!/usr/bin/env npx tsx
// @ts-nocheck
/**
 * Migrate Twitter secrets from legacy JSON blob to per-secret records.
 *
 * Canonical target format:
 *   swarm/<avatarId>/<secret_name>/default
 *
 * Legacy source:
 *   swarm/<avatarId>/secrets  (JSON containing TWITTER_* keys)
 *
 * Usage:
 *   # Dry run for one avatar
 *   npx tsx scripts/migrate-twitter-secrets.ts --avatars my-avatar
 *
 *   # Apply for one avatar
 *   npx tsx scripts/migrate-twitter-secrets.ts --avatars my-avatar --apply
 *
 *   # Apply for all avatars in STATE_TABLE
 *   STATE_TABLE=... npx tsx scripts/migrate-twitter-secrets.ts --all --apply
 *
 * Flags:
 *   --apply            Actually write secrets (default: dry-run)
 *   --overwrite        Overwrite existing per-secret values
 *   --all              Migrate all avatars listed in STATE_TABLE
 *   --avatars a,b,c    Migrate specific avatars
 *   --prefix swarm     Secret prefix (default: swarm)
 *   --region us-east-1 AWS region (default: AWS_REGION/AWS_DEFAULT_REGION/us-east-1)
 *   --concurrency 5    Parallelism (default: 4)
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
  DescribeSecretCommand,
  CreateSecretCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { createStateService } from '@swarm/core';

type Args = {
  apply: boolean;
  overwrite: boolean;
  all: boolean;
  avatars: string[];
  prefix: string;
  region: string;
  concurrency: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    overwrite: false,
    all: false,
    avatars: [],
    prefix: 'swarm',
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
    concurrency: 4,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--overwrite') args.overwrite = true;
    else if (a === '--all') args.all = true;
    else if (a === '--avatars') {
      const value = argv[++i];
      if (!value) throw new Error('--avatars requires a comma-separated list');
      args.avatars = value.split(',').map(s => s.trim()).filter(Boolean);
    } else if (a === '--prefix') {
      const value = argv[++i];
      if (!value) throw new Error('--prefix requires a value');
      args.prefix = value;
    } else if (a === '--region') {
      const value = argv[++i];
      if (!value) throw new Error('--region requires a value');
      args.region = value;
    } else if (a === '--concurrency') {
      const value = argv[++i];
      const parsed = Number.parseInt(value || '', 10);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('--concurrency must be a positive integer');
      args.concurrency = parsed;
    }
  }

  if (!args.all && args.avatars.length === 0) {
    throw new Error('Provide --all or --avatars a,b,c');
  }

  return args;
}

async function secretExists(client: SecretsManagerClient, secretId: string): Promise<boolean> {
  try {
    await client.send(new DescribeSecretCommand({ SecretId: secretId }));
    return true;
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'ResourceNotFoundException') return false;
    throw err;
  }
}

async function readJsonSecret(client: SecretsManagerClient, secretId: string): Promise<Record<string, unknown> | null> {
  try {
    const resp = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (!resp.SecretString) return null;
    return JSON.parse(resp.SecretString) as Record<string, unknown>;
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'ResourceNotFoundException') return null;
    throw err;
  }
}

function pLimit(concurrency: number) {
  let activeCount = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    activeCount--;
    const fn = queue.shift();
    if (fn) fn();
  };

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (activeCount >= concurrency) {
      await new Promise<void>(resolve => queue.push(resolve));
    }
    activeCount++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

const MAPPING: Array<{ envKey: string; secretName: string }> = [
  { envKey: 'TWITTER_API_KEY', secretName: 'twitter_api_key' },
  { envKey: 'TWITTER_API_SECRET', secretName: 'twitter_api_secret' },
  { envKey: 'TWITTER_ACCESS_TOKEN', secretName: 'twitter_access_token' },
  { envKey: 'TWITTER_ACCESS_SECRET', secretName: 'twitter_access_secret' },
];

async function migrateAvatar(client: SecretsManagerClient, args: Args, avatarId: string): Promise<{ migrated: number; skipped: number; missing: number }> {
  const jsonId = `${args.prefix}/${avatarId}/secrets`;
  const json = await readJsonSecret(client, jsonId);
  if (!json) {
    console.log(`[${avatarId}] no JSON secret found (${jsonId}); skipping`);
    return { migrated: 0, skipped: 0, missing: MAPPING.length };
  }

  let migrated = 0;
  let skipped = 0;
  let missing = 0;

  for (const { envKey, secretName } of MAPPING) {
    const value = json[envKey];
    if (typeof value !== 'string' || value.trim() === '') {
      missing++;
      console.log(`[${avatarId}] missing ${envKey} in JSON; not migrating ${secretName}`);
      continue;
    }

    const targetId = `${args.prefix}/${avatarId}/${secretName}/default`;
    const exists = await secretExists(client, targetId);

    if (exists && !args.overwrite) {
      skipped++;
      console.log(`[${avatarId}] exists: ${targetId} (skip; use --overwrite to replace)`);
      continue;
    }

    if (!args.apply) {
      migrated++;
      console.log(`[${avatarId}] would write: ${targetId}`);
      continue;
    }

    if (!exists) {
      await client.send(new CreateSecretCommand({
        Name: targetId,
        SecretString: value,
        Description: `Migrated from ${jsonId} (${envKey})`,
      }));
      migrated++;
      console.log(`[${avatarId}] created: ${targetId}`);
      continue;
    }

    await client.send(new PutSecretValueCommand({
      SecretId: targetId,
      SecretString: value,
    }));
    migrated++;
    console.log(`[${avatarId}] updated: ${targetId}`);
  }

  return { migrated, skipped, missing };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new SecretsManagerClient({ region: args.region });

  let avatarIds = args.avatars;
  if (args.all) {
    const table = process.env.STATE_TABLE;
    if (!table) {
      throw new Error('STATE_TABLE is required for --all');
    }
    const state = createStateService(table);
    avatarIds = await state.listAvatars();
  }

  const limit = pLimit(args.concurrency);

  console.log(`Starting migration: avatars=${avatarIds.length} apply=${args.apply} overwrite=${args.overwrite} prefix=${args.prefix} region=${args.region}`);

  const results = await Promise.all(avatarIds.map(avatarId =>
    limit(() => migrateAvatar(client, args, avatarId).then(r => ({ avatarId, ...r })).catch(err => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${avatarId}] ERROR: ${msg}`);
      return { avatarId, migrated: 0, skipped: 0, missing: 0, error: msg } as any;
    }))
  ));

  const totals = results.reduce((acc, r: any) => {
    acc.migrated += r.migrated || 0;
    acc.skipped += r.skipped || 0;
    acc.missing += r.missing || 0;
    acc.errors += r.error ? 1 : 0;
    return acc;
  }, { migrated: 0, skipped: 0, missing: 0, errors: 0 });

  console.log('Done. Summary:', totals);

  if (!args.apply) {
    console.log('Dry run only. Re-run with --apply to write secrets.');
  }

  if (totals.errors > 0) {
    process.exitCode = 1;
  }
}

await main();
