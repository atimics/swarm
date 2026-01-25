#!/usr/bin/env node
/**
 * Audit avatar secrets presence (no values).
 *
 * This script helps confirm avatars can resolve the "proper" secrets layout:
 * - Per-avatar per-secret records: swarm/<avatarId>/<secret>/default
 * - Shared Twitter app creds: swarm/global/twitter-app-credentials (JSON)
 * - Optional env-scoped secrets (staging/prod): swarm/<env>/<name>
 *
 * Usage:
 *   STATE_TABLE=swarm-state-staging pnpm exec tsx scripts/audit-avatar-secrets.ts --all --region us-east-1
 *   pnpm exec tsx scripts/audit-avatar-secrets.ts --avatars agent-1-55e3,agent-18-sp9g
 */

import { SecretsManagerClient, ListSecretsCommand } from '@aws-sdk/client-secrets-manager';
import { createStateService } from '@swarm/core';

type Args = {
  all: boolean;
  avatars: string[];
  prefix: string;
  region: string;
  environment?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    all: false,
    avatars: [],
    prefix: 'swarm',
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
    environment: process.env.ENVIRONMENT,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') args.all = true;
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
    } else if (a === '--environment') {
      const value = argv[++i];
      if (!value) throw new Error('--environment requires a value');
      args.environment = value;
    }
  }

  if (!args.all && args.avatars.length === 0) {
    throw new Error('Provide --all or --avatars a,b,c');
  }

  return args;
}

async function listAllSecretNames(client: SecretsManagerClient): Promise<Set<string>> {
  const names = new Set<string>();
  let nextToken: string | undefined;

  do {
    // eslint-disable-next-line no-await-in-loop
    const resp = await client.send(new ListSecretsCommand({
      MaxResults: 100,
      NextToken: nextToken,
    }));
    for (const s of resp.SecretList ?? []) {
      if (s.Name) names.add(s.Name);
    }
    nextToken = resp.NextToken;
  } while (nextToken);

  return names;
}

function nameVariants(name: string): string[] {
  return Array.from(new Set([name, name.replaceAll('_', '-')]));
}

function candidates(prefix: string, avatarId: string, secretName: string, environment?: string): string[] {
  const envName = environment?.trim();
  const ids: string[] = [];

  for (const variant of nameVariants(secretName)) {
    ids.push(`${prefix}/${avatarId}/${variant}/default`);
    ids.push(`${prefix}/${avatarId}/${variant}`);
    ids.push(`${prefix}/global/${variant}/default`);
    ids.push(`${prefix}/global/${variant}`);
    if (envName) {
      ids.push(`${prefix}/${envName}/${variant}/default`);
      ids.push(`${prefix}/${envName}/${variant}`);
    }
  }

  return ids;
}

function firstExisting(secretNames: Set<string>, ids: string[]): string | null {
  for (const id of ids) {
    if (secretNames.has(id)) return id;
  }
  return null;
}

async function auditAvatar(secretNames: Set<string>, args: Args, avatarId: string) {
  const checks = [
    { label: 'telegram_bot_token', required: false },
    { label: 'telegram_webhook_secret', required: false },
    { label: 'discord_bot_token', required: false },
    { label: 'openrouter_api_key', required: false },
    { label: 'replicate_api_key', required: false },
    // Twitter OAuth tokens are avatar-scoped.
    { label: 'twitter_access_token', required: false },
    { label: 'twitter_access_secret', required: false },
  ];

  const found: Record<string, string | null> = {};
  for (const c of checks) {
    found[c.label] = firstExisting(secretNames, candidates(args.prefix, avatarId, c.label, args.environment));
  }

  // Twitter app credentials are shared.
  const twitterAppCreds = firstExisting(secretNames, [
    `${args.prefix}/global/twitter-app-credentials`,
    `${args.prefix}/global/twitter-app-credentials/default`,
  ]);

  const missing = Object.entries(found).filter(([, v]) => !v).map(([k]) => k);

  return {
    avatarId,
    found,
    twitterAppCreds,
    missing,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new SecretsManagerClient({ region: args.region });

  const secretNames = await listAllSecretNames(client);

  let avatarIds = args.avatars;
  if (args.all) {
    const table = process.env.STATE_TABLE;
    if (!table) throw new Error('STATE_TABLE is required for --all');
    avatarIds = await createStateService(table).listAvatars();
  }

  console.log(`Auditing secrets: avatars=${avatarIds.length} prefix=${args.prefix} region=${args.region} env=${args.environment || '(none)'}`);

  const results = [] as Array<Awaited<ReturnType<typeof auditAvatar>>>;
  for (const avatarId of avatarIds) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await auditAvatar(secretNames, args, avatarId));
  }

  const twitterAppCredsPresent = results.some(r => r.twitterAppCreds);
  console.log(`Shared twitter-app-credentials present: ${twitterAppCredsPresent}`);

  const withTwitterTokens = results.filter(r => r.found.twitter_access_token && r.found.twitter_access_secret);
  console.log(`Avatars with Twitter access tokens: ${withTwitterTokens.length}/${results.length}`);

  const missingCounts = results.reduce<Record<string, number>>((acc, r) => {
    for (const m of r.missing) acc[m] = (acc[m] || 0) + 1;
    return acc;
  }, {});

  console.log('Missing counts (by secret):');
  for (const k of Object.keys(missingCounts).sort()) {
    console.log(`- ${k}: ${missingCounts[k]}`);
  }

  // Print a short per-avatar list for those that have twitter tokens but would rely on shared app creds.
  const twitterReliant = withTwitterTokens.filter(r => !r.found.twitter_api_key && !r.found.twitter_api_secret);
  if (twitterReliant.length > 0) {
    console.log('Avatars with Twitter tokens (app creds expected via shared twitter-app-credentials):');
    for (const r of twitterReliant) {
      console.log(`- ${r.avatarId}`);
    }
  }
}

main().catch(err => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`ERROR: ${msg}`);
  process.exitCode = 1;
});
