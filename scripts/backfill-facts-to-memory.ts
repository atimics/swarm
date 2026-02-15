#!/usr/bin/env -S npx tsx
// @ts-nocheck
/**
 * Backfill legacy FACT# entries from STATE_TABLE into canonical MEMORY#
 * items in ADMIN_TABLE. Part of the Unified Agent Brain migration (RFC Phase 3).
 *
 * Legacy schema:
 *   pk: AVATAR#{avatarId}
 *   sk: FACT#{about}#{hash}
 *   Fields: fact, about, userId, timestamp, ttl
 *
 * Canonical schema:
 *   pk: MEMORY#{avatarId}
 *   sk: recent#{timestamp}#{id}
 *   Fields: id, avatarId, tier, type, content, about, userId, strength, createdAt, updatedAt, ttl, metadata
 *
 * Idempotency: Uses a deterministic ID derived from the source sk, so
 * re-running produces the same items (DynamoDB PutCommand overwrites).
 *
 * Usage:
 *   # Dry run for specific avatars
 *   STATE_TABLE=swarm-state-prod ADMIN_TABLE=SwarmAdmin-prod \
 *     npx tsx scripts/backfill-facts-to-memory.ts --avatars my-avatar,other-avatar
 *
 *   # Dry run for all avatars in STATE_TABLE
 *   STATE_TABLE=swarm-state-prod ADMIN_TABLE=SwarmAdmin-prod \
 *     npx tsx scripts/backfill-facts-to-memory.ts --all
 *
 *   # Actually write (apply)
 *   STATE_TABLE=swarm-state-prod ADMIN_TABLE=SwarmAdmin-prod \
 *     npx tsx scripts/backfill-facts-to-memory.ts --all --apply
 *
 * Flags:
 *   --apply            Actually write to ADMIN_TABLE (default: dry-run)
 *   --all              Backfill all avatars in STATE_TABLE
 *   --avatars a,b,c    Backfill specific avatars
 *   --tier recent      Target tier (default: recent)
 *   --retention 30     Retention days for new items (default: 30, -1 for unlimited)
 *   --batch-size 25    DynamoDB BatchWriteItem size (default: 25, max 25)
 *   --region us-east-1 AWS region (default: AWS_REGION or us-east-1)
 *   --sample 5         Print N sample items per avatar in dry-run (default: 3)
 */

import { createHash } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  BatchWriteCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Args {
  apply: boolean;
  all: boolean;
  avatars: string[];
  tier: string;
  retentionDays: number;
  batchSize: number;
  region: string;
  sample: number;
}

interface LegacyFact {
  pk: string;
  sk: string;
  fact: string;
  about?: string;
  userId?: string;
  timestamp?: number;
  ttl?: number;
}

interface CanonicalMemoryItem {
  pk: string;
  sk: string;
  id: string;
  avatarId: string;
  tier: string;
  type: string;
  content: string;
  about?: string;
  userId?: string;
  strength: number;
  createdAt: number;
  updatedAt: number;
  ttl?: number;
  metadata: Record<string, unknown>;
}

interface AvatarResult {
  avatarId: string;
  factsFound: number;
  written: number;
  skipped: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    all: false,
    avatars: [],
    tier: 'recent',
    retentionDays: 30,
    batchSize: 25,
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
    sample: 3,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--all') args.all = true;
    else if (a === '--avatars') {
      const value = argv[++i];
      if (!value) throw new Error('--avatars requires a comma-separated list');
      args.avatars = value.split(',').map(s => s.trim()).filter(Boolean);
    } else if (a === '--tier') {
      const value = argv[++i];
      if (!value || !['immediate', 'recent', 'core'].includes(value)) {
        throw new Error('--tier must be one of: immediate, recent, core');
      }
      args.tier = value;
    } else if (a === '--retention') {
      const value = Number.parseInt(argv[++i] || '', 10);
      if (!Number.isFinite(value)) throw new Error('--retention must be a number');
      args.retentionDays = value;
    } else if (a === '--batch-size') {
      const value = Number.parseInt(argv[++i] || '', 10);
      if (!Number.isFinite(value) || value <= 0 || value > 25) {
        throw new Error('--batch-size must be 1-25');
      }
      args.batchSize = value;
    } else if (a === '--region') {
      const value = argv[++i];
      if (!value) throw new Error('--region requires a value');
      args.region = value;
    } else if (a === '--sample') {
      const value = Number.parseInt(argv[++i] || '', 10);
      if (!Number.isFinite(value) || value < 0) throw new Error('--sample must be >= 0');
      args.sample = value;
    }
  }

  if (!args.all && args.avatars.length === 0) {
    throw new Error('Provide --all or --avatars a,b,c');
  }

  return args;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECONDS_PER_DAY = 86400;

function deterministicId(sourceSk: string): string {
  return createHash('sha256').update(sourceSk).digest('hex').slice(0, 32);
}

function deterministicTimestamp(sourceSk: string): number {
  // 12 hex chars = 48 bits, safely within JS integer precision.
  const hex = createHash('sha256').update(`ts:${sourceSk}`).digest('hex').slice(0, 12);
  return Number.parseInt(hex, 16);
}

function computeTtl(retentionDays: number): number | undefined {
  if (retentionDays === -1) return undefined;
  return Math.floor(Date.now() / 1000) + retentionDays * SECONDS_PER_DAY;
}

function transformFact(
  fact: LegacyFact,
  avatarId: string,
  tier: string,
  retentionDays: number
): CanonicalMemoryItem {
  const id = deterministicId(fact.sk);
  const timestamp = typeof fact.timestamp === 'number' && fact.timestamp > 0
    ? fact.timestamp
    : deterministicTimestamp(fact.sk);
  const now = Date.now();
  const ttl = computeTtl(retentionDays);

  const item: CanonicalMemoryItem = {
    pk: `MEMORY#${avatarId}`,
    sk: `${tier}#${timestamp}#${id}`,
    id,
    avatarId,
    tier,
    type: fact.about && fact.about !== 'general' ? 'fact' : 'event',
    content: (fact.fact || '').slice(0, 2000),
    strength: 1.0,
    createdAt: timestamp,
    updatedAt: now,
    metadata: {
      backfilledFrom: 'STATE_TABLE',
      sourceSk: fact.sk,
      backfilledAt: now,
    },
  };

  if (fact.about && fact.about !== 'general') {
    item.about = fact.about.slice(0, 100);
  }
  if (fact.userId) {
    item.userId = fact.userId;
  }
  if (ttl !== undefined) {
    item.ttl = ttl;
  }

  return item;
}

// ---------------------------------------------------------------------------
// DynamoDB operations
// ---------------------------------------------------------------------------

async function scanAllFacts(
  docClient: DynamoDBDocumentClient,
  stateTable: string,
  avatarId: string
): Promise<LegacyFact[]> {
  const facts: LegacyFact[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: stateTable,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `AVATAR#${avatarId}`,
          ':prefix': 'FACT#',
        },
        ExclusiveStartKey: lastKey,
      })
    );

    for (const item of result.Items || []) {
      facts.push(item as LegacyFact);
    }

    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return facts;
}

async function writeBatch(
  docClient: DynamoDBDocumentClient,
  adminTable: string,
  items: CanonicalMemoryItem[],
  batchSize: number
): Promise<{ written: number; errors: number }> {
  let written = 0;
  let errors = 0;

  // DynamoDB BatchWriteItem accepts max 25 items
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const requestItems = batch.map(item => ({
      PutRequest: { Item: item },
    }));

    try {
      const result = await docClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [adminTable]: requestItems,
          },
        })
      );

      const unprocessed = result.UnprocessedItems?.[adminTable]?.length || 0;
      written += batch.length - unprocessed;
      if (unprocessed > 0) {
        errors += unprocessed;
        console.error(`  Warning: ${unprocessed} unprocessed items in batch`);
      }
    } catch (err) {
      errors += batch.length;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Batch write error: ${msg}`);
    }
  }

  return { written, errors };
}

async function listAllAvatars(
  docClient: DynamoDBDocumentClient,
  stateTable: string
): Promise<string[]> {
  // Query the GSI for CONFIG items (same approach as DynamoDBStateService.listAvatars)
  const avatarIds = new Set<string>();
  let lastKey: Record<string, unknown> | undefined;

  // Try GSI first
  do {
    try {
      const result = await docClient.send(
        new QueryCommand({
          TableName: stateTable,
          IndexName: 'gsi1',
          KeyConditionExpression: 'gsi1pk = :pk',
          ExpressionAttributeValues: { ':pk': 'CONFIG' },
          ProjectionExpression: 'gsi1sk',
          ExclusiveStartKey: lastKey,
        })
      );

      for (const item of result.Items || []) {
        if (item.gsi1sk) avatarIds.add(item.gsi1sk as string);
      }

      lastKey = result.LastEvaluatedKey;
    } catch {
      // GSI may not exist; fall back to scan
      break;
    }
  } while (lastKey);

  if (avatarIds.size > 0) return [...avatarIds];

  // Fallback: full table scan for CONFIG records.
  console.log('  GSI query returned no results, falling back to scan...');
  lastKey = undefined;
  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: stateTable,
        FilterExpression: 'begins_with(pk, :prefix) AND sk = :sk',
        ExpressionAttributeValues: {
          ':prefix': 'AVATAR#',
          ':sk': 'CONFIG',
        },
        ProjectionExpression: 'pk',
        ExclusiveStartKey: lastKey,
      })
    );

    for (const item of result.Items || []) {
      const pk = item.pk as string | undefined;
      if (!pk?.startsWith('AVATAR#')) continue;
      avatarIds.add(pk.replace('AVATAR#', ''));
    }

    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return [...avatarIds];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function backfillAvatar(
  docClient: DynamoDBDocumentClient,
  stateTable: string,
  adminTable: string,
  avatarId: string,
  args: Args
): Promise<AvatarResult> {
  const facts = await scanAllFacts(docClient, stateTable, avatarId);

  if (facts.length === 0) {
    console.log(`[${avatarId}] No facts found, skipping`);
    return { avatarId, factsFound: 0, written: 0, skipped: 0, errors: 0 };
  }

  console.log(`[${avatarId}] Found ${facts.length} legacy facts`);

  // Transform all facts
  const items = facts
    .filter(f => f.fact && f.fact.trim().length > 0)
    .map(f => transformFact(f, avatarId, args.tier, args.retentionDays));

  const skipped = facts.length - items.length;
  if (skipped > 0) {
    console.log(`[${avatarId}] Skipped ${skipped} empty/invalid facts`);
  }

  if (!args.apply) {
    // Dry run: print samples
    const sampleCount = Math.min(args.sample, items.length);
    if (sampleCount > 0) {
      console.log(`[${avatarId}] Sample items (${sampleCount} of ${items.length}):`);
      for (let i = 0; i < sampleCount; i++) {
        const item = items[i];
        console.log(`  ${i + 1}. pk=${item.pk} sk=${item.sk}`);
        console.log(`     content: ${item.content.slice(0, 80)}${item.content.length > 80 ? '...' : ''}`);
        console.log(`     about=${item.about || '(none)'} type=${item.type} tier=${item.tier}`);
      }
    }
    return { avatarId, factsFound: facts.length, written: 0, skipped, errors: 0 };
  }

  // Write in batches
  const { written, errors } = await writeBatch(docClient, adminTable, items, args.batchSize);
  console.log(`[${avatarId}] Wrote ${written} items, ${errors} errors`);

  return { avatarId, factsFound: facts.length, written, skipped, errors };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const stateTable = process.env.STATE_TABLE;
  const adminTable = process.env.ADMIN_TABLE;

  if (!stateTable) throw new Error('STATE_TABLE environment variable is required');
  if (!adminTable) throw new Error('ADMIN_TABLE environment variable is required');

  const docClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: args.region }),
    { marshallOptions: { removeUndefinedValues: true } }
  );

  // Resolve avatar list
  let avatarIds = args.avatars;
  if (args.all) {
    console.log('Discovering avatars from STATE_TABLE...');
    avatarIds = await listAllAvatars(docClient, stateTable);
    if (avatarIds.length === 0) {
      console.log('No avatars found in STATE_TABLE');
      return;
    }
    console.log(`Found ${avatarIds.length} avatars: ${avatarIds.join(', ')}`);
  }

  console.log('');
  console.log('='.repeat(60));
  console.log(`Backfill: FACT# → MEMORY#`);
  console.log(`  STATE_TABLE:  ${stateTable}`);
  console.log(`  ADMIN_TABLE:  ${adminTable}`);
  console.log(`  Avatars:      ${avatarIds.length}`);
  console.log(`  Target tier:  ${args.tier}`);
  console.log(`  Retention:    ${args.retentionDays === -1 ? 'unlimited' : `${args.retentionDays} days`}`);
  console.log(`  Mode:         ${args.apply ? 'APPLY (writing!)' : 'DRY RUN'}`);
  console.log('='.repeat(60));
  console.log('');

  const results: AvatarResult[] = [];

  for (const avatarId of avatarIds) {
    try {
      const result = await backfillAvatar(
        docClient,
        stateTable,
        adminTable,
        avatarId,
        args
      );
      results.push(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${avatarId}] ERROR: ${msg}`);
      results.push({
        avatarId,
        factsFound: 0,
        written: 0,
        skipped: 0,
        errors: 1,
      });
    }
  }

  // Summary
  const totals = results.reduce(
    (acc, r) => {
      acc.factsFound += r.factsFound;
      acc.written += r.written;
      acc.skipped += r.skipped;
      acc.errors += r.errors;
      return acc;
    },
    { factsFound: 0, written: 0, skipped: 0, errors: 0 }
  );

  console.log('');
  console.log('='.repeat(60));
  console.log('Summary:');
  console.log(`  Avatars processed: ${results.length}`);
  console.log(`  Facts found:       ${totals.factsFound}`);
  console.log(`  Items written:     ${totals.written}`);
  console.log(`  Items skipped:     ${totals.skipped} (empty/invalid)`);
  console.log(`  Errors:            ${totals.errors}`);
  console.log('='.repeat(60));

  if (!args.apply) {
    console.log('');
    console.log('Dry run complete. Re-run with --apply to write items.');
  }

  if (totals.errors > 0) {
    process.exitCode = 1;
  }
}

await main();
