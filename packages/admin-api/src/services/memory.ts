/**
 * Memory Service
 *
 * Tiered memory system for agent personality evolution.
 * Implements immediate/recent/core memory tiers with:
 * - Strength-based retention (reinforcement + decay)
 * - Automatic consolidation (summarization + promotion)
 * - Semantic search via embeddings
 */
import { randomUUID } from 'crypto';
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  DeleteCommand,
  UpdateCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { logger } from '@swarm/core';
import type {
  AgentMemory,
  MemoryTier,
  MemoryType,
  MemoryQueryOptions,
  MemoryConsolidationConfig,
  AgentIdentitySnapshot,
} from '../types.js';

// ============================================================================
// Configuration
// ============================================================================

const ADMIN_TABLE = process.env.ADMIN_TABLE!;

const DEFAULT_CONFIG: MemoryConsolidationConfig = {
  immediateMaxCount: 10,
  recentMaxCount: 50,
  recentSummaryThreshold: 10,
  coreMaxCount: 100,
  decayRate: 0.95,
  decayIntervalHours: 24,
  pruneThreshold: 0.1,
  reinforcementBoost: 0.1,
};

// ============================================================================
// DynamoDB Client
// ============================================================================

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

// ============================================================================
// Memory CRUD Operations
// ============================================================================

/**
 * Create a new memory
 */
export async function createMemory(
  agentId: string,
  params: {
    tier: MemoryTier;
    type: MemoryType;
    content: string;
    about?: string;
    userId?: string;
    themes?: string[];
    strength?: number;
    embedding?: number[];
    metadata?: Record<string, unknown>;
    sourceMemoryIds?: string[];
  }
): Promise<AgentMemory> {
  const now = Date.now();
  const id = randomUUID();
  const tier = params.tier;

  const memory: AgentMemory = {
    pk: `MEMORY#${agentId}`,
    sk: `${tier}#${now}#${id}`,
    id,
    agentId,
    tier,
    type: params.type,
    content: params.content,
    about: params.about,
    userId: params.userId,
    themes: params.themes,
    strength: params.strength ?? 1.0,
    embedding: params.embedding,
    metadata: params.metadata,
    createdAt: now,
    updatedAt: now,
    sourceMemoryIds: params.sourceMemoryIds,
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: memory,
  }));

  logger.info('Memory created', {
    event: 'memory_created',
    agentId,
    memoryId: id,
    tier,
    type: params.type,
  });

  return memory;
}

/**
 * Get memories for an agent with optional filters
 */
export async function getMemories(
  agentId: string,
  options: MemoryQueryOptions = {}
): Promise<AgentMemory[]> {
  const { tier, limit = 100, minStrength = 0 } = options;

  // Build key condition
  let keyCondition = 'pk = :pk';
  const expressionValues: Record<string, unknown> = {
    ':pk': `MEMORY#${agentId}`,
  };

  if (tier) {
    keyCondition += ' AND begins_with(sk, :tier)';
    expressionValues[':tier'] = `${tier}#`;
  }

  // Build filter expression
  const filterParts: string[] = [];
  if (options.type) {
    filterParts.push('#type = :type');
    expressionValues[':type'] = options.type;
  }
  if (options.about) {
    filterParts.push('about = :about');
    expressionValues[':about'] = options.about;
  }
  if (options.userId) {
    filterParts.push('userId = :userId');
    expressionValues[':userId'] = options.userId;
  }
  if (minStrength > 0) {
    filterParts.push('strength >= :minStrength');
    expressionValues[':minStrength'] = minStrength;
  }

  const result = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: keyCondition,
    ExpressionAttributeValues: expressionValues,
    ...(filterParts.length > 0 ? {
      FilterExpression: filterParts.join(' AND '),
      ExpressionAttributeNames: { '#type': 'type' },
    } : {}),
    ScanIndexForward: false, // Newest first
    Limit: limit,
  }));

  return (result.Items || []) as AgentMemory[];
}

/**
 * Get memories by tier with counts
 */
export async function getMemoryCounts(agentId: string): Promise<Record<MemoryTier, number>> {
  const counts: Record<MemoryTier, number> = {
    immediate: 0,
    recent: 0,
    core: 0,
  };

  for (const tier of ['immediate', 'recent', 'core'] as MemoryTier[]) {
    const result = await dynamoClient.send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :tier)',
      ExpressionAttributeValues: {
        ':pk': `MEMORY#${agentId}`,
        ':tier': `${tier}#`,
      },
      Select: 'COUNT',
    }));
    counts[tier] = result.Count || 0;
  }

  return counts;
}

/**
 * Update memory strength (for reinforcement)
 */
export async function reinforceMemory(
  agentId: string,
  memoryId: string,
  sk: string,
  boost: number = DEFAULT_CONFIG.reinforcementBoost
): Promise<void> {
  await dynamoClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `MEMORY#${agentId}`,
      sk,
    },
    UpdateExpression: 'SET strength = if_not_exists(strength, :one) + :boost, updatedAt = :now',
    ExpressionAttributeValues: {
      ':boost': boost,
      ':one': 1.0,
      ':now': Date.now(),
    },
  }));

  logger.info('Memory reinforced', {
    event: 'memory_reinforced',
    agentId,
    memoryId,
    boost,
  });
}

/**
 * Delete a memory
 */
export async function deleteMemory(agentId: string, sk: string): Promise<void> {
  await dynamoClient.send(new DeleteCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `MEMORY#${agentId}`,
      sk,
    },
  }));
}

/**
 * Delete multiple memories (batch)
 */
export async function deleteMemories(agentId: string, sks: string[]): Promise<void> {
  // DynamoDB batch write limit is 25
  const batches: string[][] = [];
  for (let i = 0; i < sks.length; i += 25) {
    batches.push(sks.slice(i, i + 25));
  }

  for (const batch of batches) {
    await dynamoClient.send(new BatchWriteCommand({
      RequestItems: {
        [ADMIN_TABLE]: batch.map(sk => ({
          DeleteRequest: {
            Key: {
              pk: `MEMORY#${agentId}`,
              sk,
            },
          },
        })),
      },
    }));
  }
}

// ============================================================================
// Memory Query Helpers
// ============================================================================

/**
 * Get recent memories about a specific topic/person
 */
export async function recallAbout(
  agentId: string,
  about: string,
  limit: number = 10
): Promise<AgentMemory[]> {
  // Query across all tiers, filter by about
  const result = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk',
    FilterExpression: 'about = :about',
    ExpressionAttributeValues: {
      ':pk': `MEMORY#${agentId}`,
      ':about': about,
    },
    ScanIndexForward: false,
    Limit: limit * 3, // Over-fetch to account for filter
  }));

  return ((result.Items || []) as AgentMemory[]).slice(0, limit);
}

/**
 * Search memories by content (simple text match)
 * TODO: Implement semantic search with embeddings
 */
export async function searchMemories(
  agentId: string,
  query: string,
  limit: number = 10
): Promise<AgentMemory[]> {
  const queryLower = query.toLowerCase();

  // Get all memories and filter (not ideal, but works for now)
  // TODO: Add GSI or use embeddings for better search
  const result = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: {
      ':pk': `MEMORY#${agentId}`,
    },
    ScanIndexForward: false,
  }));

  const memories = (result.Items || []) as AgentMemory[];

  // Score memories by relevance
  const scored = memories
    .map(m => {
      let score = 0;
      const contentLower = m.content.toLowerCase();
      const aboutLower = (m.about || '').toLowerCase();

      // Exact match in about
      if (aboutLower === queryLower) score += 10;
      // Partial match in about
      else if (aboutLower.includes(queryLower)) score += 5;

      // Match in content
      if (contentLower.includes(queryLower)) score += 3;

      // Match in themes
      if (m.themes?.some(t => t.toLowerCase().includes(queryLower))) score += 2;

      // Boost by strength and tier
      score *= m.strength;
      if (m.tier === 'core') score *= 1.5;
      else if (m.tier === 'recent') score *= 1.2;

      return { memory: m, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(({ memory }) => memory);
}

/**
 * Get core memories (identity, learnings, patterns)
 */
export async function getCoreMemories(agentId: string): Promise<AgentMemory[]> {
  return getMemories(agentId, {
    tier: 'core',
    minStrength: DEFAULT_CONFIG.pruneThreshold,
    limit: DEFAULT_CONFIG.coreMaxCount,
  });
}

/**
 * Get identity statements
 */
export async function getIdentity(agentId: string): Promise<AgentMemory[]> {
  return getMemories(agentId, {
    tier: 'core',
    type: 'identity',
    limit: 5,
  });
}

// ============================================================================
// Consolidation Operations
// ============================================================================

/**
 * Apply decay to all memories in a tier
 */
export async function applyDecay(
  agentId: string,
  tier: MemoryTier,
  decayRate: number = DEFAULT_CONFIG.decayRate
): Promise<{ decayed: number; pruned: number }> {
  const memories = await getMemories(agentId, { tier, limit: 1000 });

  let decayed = 0;
  let pruned = 0;
  const toPrune: string[] = [];

  for (const memory of memories) {
    const newStrength = memory.strength * decayRate;

    if (newStrength < DEFAULT_CONFIG.pruneThreshold) {
      toPrune.push(memory.sk);
      pruned++;
    } else {
      await dynamoClient.send(new UpdateCommand({
        TableName: ADMIN_TABLE,
        Key: { pk: memory.pk, sk: memory.sk },
        UpdateExpression: 'SET strength = :strength, updatedAt = :now',
        ExpressionAttributeValues: {
          ':strength': newStrength,
          ':now': Date.now(),
        },
      }));
      decayed++;
    }
  }

  if (toPrune.length > 0) {
    await deleteMemories(agentId, toPrune);
  }

  logger.info('Memory decay applied', {
    event: 'memory_decay',
    agentId,
    tier,
    decayed,
    pruned,
  });

  return { decayed, pruned };
}

/**
 * Promote oldest immediate memories to recent tier
 */
export async function promoteImmediateToRecent(
  agentId: string,
  maxImmediate: number = DEFAULT_CONFIG.immediateMaxCount
): Promise<{ promoted: number }> {
  const immediateMemories = await getMemories(agentId, { tier: 'immediate', limit: 1000 });

  if (immediateMemories.length <= maxImmediate) {
    return { promoted: 0 };
  }

  // Sort by creation time, oldest first
  const sorted = [...immediateMemories].sort((a, b) => a.createdAt - b.createdAt);
  const toPromote = sorted.slice(0, sorted.length - maxImmediate);

  for (const memory of toPromote) {
    // Create new memory in recent tier
    await createMemory(agentId, {
      tier: 'recent',
      type: memory.type,
      content: memory.content,
      about: memory.about,
      userId: memory.userId,
      themes: memory.themes,
      strength: memory.strength * 0.9, // Slight decay on promotion
      metadata: memory.metadata,
      sourceMemoryIds: [memory.id],
    });

    // Delete from immediate tier
    await deleteMemory(agentId, memory.sk);
  }

  logger.info('Immediate memories promoted to recent', {
    event: 'memory_promotion',
    agentId,
    promoted: toPromote.length,
  });

  return { promoted: toPromote.length };
}

/**
 * Save an identity snapshot
 */
export async function saveIdentitySnapshot(
  agentId: string,
  statement: string,
  triggeringMemories: string[],
  previousStatement?: string
): Promise<AgentIdentitySnapshot> {
  const now = Date.now();
  const snapshot: AgentIdentitySnapshot = {
    pk: `IDENTITY#${agentId}`,
    sk: `SNAPSHOT#${now}`,
    agentId,
    statement,
    previousStatement,
    triggeringMemories,
    createdAt: now,
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: snapshot,
  }));

  // Also create a core memory for the identity
  await createMemory(agentId, {
    tier: 'core',
    type: 'identity',
    content: statement,
    strength: 1.0,
    metadata: { snapshotSk: snapshot.sk },
  });

  logger.info('Identity snapshot saved', {
    event: 'identity_snapshot',
    agentId,
    statement,
  });

  return snapshot;
}

/**
 * Get identity history
 */
export async function getIdentityHistory(
  agentId: string,
  limit: number = 10
): Promise<AgentIdentitySnapshot[]> {
  const result = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': `IDENTITY#${agentId}`,
      ':prefix': 'SNAPSHOT#',
    },
    ScanIndexForward: false,
    Limit: limit,
  }));

  return (result.Items || []) as AgentIdentitySnapshot[];
}

// ============================================================================
// High-Level Memory API (for MCP tools)
// ============================================================================

/**
 * Remember a fact (creates immediate memory)
 */
export async function remember(
  agentId: string,
  fact: string,
  about?: string,
  userId?: string
): Promise<{ saved: boolean; memoryId: string }> {
  // Check for similar existing memory to reinforce
  if (about) {
    const existing = await recallAbout(agentId, about, 5);
    const similar = existing.find(m =>
      m.content.toLowerCase().includes(fact.toLowerCase().slice(0, 20)) ||
      fact.toLowerCase().includes(m.content.toLowerCase().slice(0, 20))
    );

    if (similar) {
      await reinforceMemory(agentId, similar.id, similar.sk);
      return { saved: true, memoryId: similar.id };
    }
  }

  // Create new immediate memory
  const memory = await createMemory(agentId, {
    tier: 'immediate',
    type: about ? 'fact' : 'event',
    content: fact,
    about,
    userId,
  });

  // Check if we need to promote memories
  await promoteImmediateToRecent(agentId);

  return { saved: true, memoryId: memory.id };
}

/**
 * Recall facts (searches across all tiers)
 */
export async function recall(
  agentId: string,
  query: string,
  userId?: string
): Promise<{ facts: Array<{ fact: string; about?: string; timestamp: number; strength: number }> }> {
  const memories = await searchMemories(agentId, query, 10);

  // Filter by userId if provided
  const filtered = userId
    ? memories.filter(m => !m.userId || m.userId === userId)
    : memories;

  return {
    facts: filtered.map(m => ({
      fact: m.content,
      about: m.about,
      timestamp: m.createdAt,
      strength: m.strength,
    })),
  };
}

/**
 * Get memory context for prompt injection
 */
export async function getMemoryContext(agentId: string): Promise<string> {
  const [coreMemories, recentMemories, identity] = await Promise.all([
    getCoreMemories(agentId),
    getMemories(agentId, { tier: 'recent', limit: 10 }),
    getIdentity(agentId),
  ]);

  const sections: string[] = [];

  // Identity section
  if (identity.length > 0) {
    sections.push('## Who I Am');
    for (const mem of identity) {
      sections.push(`- ${mem.content}`);
    }
  }

  // Core learnings and patterns
  const learnings = coreMemories.filter(m => m.type === 'learning' || m.type === 'pattern');
  if (learnings.length > 0) {
    sections.push('\n## What I\'ve Learned');
    for (const mem of learnings.slice(0, 5)) {
      sections.push(`- ${mem.content}`);
    }
  }

  // Recent experiences
  if (recentMemories.length > 0) {
    sections.push('\n## Recent Experiences');
    for (const mem of recentMemories.slice(0, 5)) {
      const aboutStr = mem.about ? ` (about ${mem.about})` : '';
      sections.push(`- ${mem.content}${aboutStr}`);
    }
  }

  return sections.join('\n');
}
