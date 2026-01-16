/**
 * Memory Service
 *
 * Tiered memory system for avatar personality evolution.
 * Implements immediate/recent/core memory tiers with:
 * - Strength-based retention (reinforcement + decay)
 * - Automatic consolidation (summarization + promotion)
 * - Semantic search via embeddings (future)
 *
 * DynamoDB Key Schema:
 * - pk: MEMORY#{avatarId}
 * - sk: {tier}#{timestamp}#{id}
 *
 * @module memory
 */
import { randomUUID } from 'crypto';
import {
  DynamoDBClient,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  DeleteCommand,
  UpdateCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { logger } from '@swarm/core';
import type {
  AvatarMemory,
  MemoryTier,
  MemoryType,
  MemoryQueryOptions,
  MemoryConsolidationConfig,
  AvatarIdentitySnapshot,
} from '../types.js';
import {
  getEmbeddingService,
  cosineSimilarity,
  EMBEDDING_VERSION,
} from './embedding.js';

// ============================================================================
// Configuration
// ============================================================================

const ADMIN_TABLE = process.env.ADMIN_TABLE || 'swarm-admin-table';

/** Maximum content length for a single memory (characters) */
const MAX_CONTENT_LENGTH = 2000;

/** Maximum number of themes per memory */
const MAX_THEMES = 10;

/** Maximum strength value (capped on reinforcement) */
const MAX_STRENGTH = 2.0;

/** Default configuration for memory consolidation */
export const DEFAULT_CONFIG: MemoryConsolidationConfig = {
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

let _dynamoClient: DynamoDBDocumentClient | null = null;

function getDynamoClient(): DynamoDBDocumentClient {
  if (!_dynamoClient) {
    _dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return _dynamoClient;
}

// For testing - allows injecting a mock client
export function _setDynamoClient(client: DynamoDBDocumentClient | null): void {
  _dynamoClient = client;
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate and sanitize avatar ID
 */
function validateAvatarId(avatarId: string): string {
  if (!avatarId || typeof avatarId !== 'string') {
    throw new Error('avatarId is required');
  }
  const trimmed = avatarId.trim();
  if (trimmed.length === 0) {
    throw new Error('avatarId cannot be empty');
  }
  if (trimmed.length > 100) {
    throw new Error('avatarId too long (max 100 characters)');
  }
  // Sanitize: only allow alphanumeric, dash, underscore
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new Error('avatarId contains invalid characters');
  }
  return trimmed;
}

/**
 * Validate and sanitize memory content
 */
function validateContent(content: string): string {
  if (!content || typeof content !== 'string') {
    throw new Error('content is required');
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw new Error('content cannot be empty');
  }
  if (trimmed.length > MAX_CONTENT_LENGTH) {
    // Truncate instead of throwing - graceful degradation
    logger.warn('Memory content truncated', {
      event: 'memory_content_truncated',
      originalLength: content.length,
      maxLength: MAX_CONTENT_LENGTH,
    });
    return trimmed.slice(0, MAX_CONTENT_LENGTH);
  }
  return trimmed;
}

/**
 * Validate and sanitize themes array
 */
function validateThemes(themes?: string[]): string[] | undefined {
  if (!themes || !Array.isArray(themes)) {
    return undefined;
  }
  return themes
    .filter(t => typeof t === 'string' && t.trim().length > 0)
    .map(t => t.trim().toLowerCase().slice(0, 50))
    .slice(0, MAX_THEMES);
}

/**
 * Validate strength value
 */
function validateStrength(strength?: number): number {
  if (strength === undefined || strength === null) {
    return 1.0;
  }
  if (typeof strength !== 'number' || isNaN(strength)) {
    return 1.0;
  }
  return Math.max(0, Math.min(MAX_STRENGTH, strength));
}

// ============================================================================
// Memory CRUD Operations
// ============================================================================

/**
 * Create a new memory
 *
 * Automatically generates vector embeddings for semantic search unless
 * an embedding is provided or generation fails (graceful degradation).
 *
 * @param avatarId - The avatar's unique identifier
 * @param params - Memory creation parameters
 * @returns The created memory record
 * @throws Error if validation fails
 */
export async function createMemory(
  avatarId: string,
  params: {
    tier: MemoryTier;
    type: MemoryType;
    content: string;
    about?: string;
    userId?: string;
    themes?: string[];
    strength?: number;
    embedding?: number[];
    skipEmbedding?: boolean;
    metadata?: Record<string, unknown>;
    sourceMemoryIds?: string[];
  }
): Promise<AvatarMemory> {
  // Validate inputs
  const validAvatarId = validateAvatarId(avatarId);
  const validContent = validateContent(params.content);
  const validThemes = validateThemes(params.themes);
  const validStrength = validateStrength(params.strength);

  const now = Date.now();
  const id = randomUUID();
  const tier = params.tier;

  // Generate embedding if not provided and not skipped
  let embedding = params.embedding;
  let embeddingModel: string | undefined;
  let embeddingVersion: number | undefined;

  if (!embedding && !params.skipEmbedding) {
    try {
      const embeddingService = getEmbeddingService();
      embedding = await embeddingService.embed(validContent);
      embeddingModel = embeddingService.modelId;
      embeddingVersion = EMBEDDING_VERSION;
    } catch (error) {
      // Graceful degradation - continue without embedding
      logger.warn('Failed to generate embedding for memory', {
        event: 'embedding_generation_error',
        avatarId: validAvatarId,
        memoryId: id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  const memory: AvatarMemory = {
    pk: `MEMORY#${validAvatarId}`,
    sk: `${tier}#${now}#${id}`,
    id,
    avatarId: validAvatarId,
    tier,
    type: params.type,
    content: validContent,
    about: params.about?.trim().slice(0, 100),
    userId: params.userId?.trim().slice(0, 100),
    themes: validThemes,
    strength: validStrength,
    embedding,
    embeddingModel,
    embeddingVersion,
    metadata: params.metadata,
    createdAt: now,
    updatedAt: now,
    sourceMemoryIds: params.sourceMemoryIds,
  };

  try {
    await getDynamoClient().send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: memory,
    }));

    logger.info('Memory created', {
      event: 'memory_created',
      avatarId: validAvatarId,
      memoryId: id,
      tier,
      type: params.type,
      contentLength: validContent.length,
      hasEmbedding: !!embedding,
    });

    return memory;
  } catch (error) {
    logger.error('Failed to create memory', {
      event: 'memory_create_error',
      avatarId: validAvatarId,
      tier,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

/**
 * Get a single memory by ID
 *
 * @param avatarId - The avatar's unique identifier
 * @param memoryId - The memory's unique identifier
 * @param tier - The memory tier (required for efficient lookup)
 * @returns The memory record or null if not found
 */
export async function getMemory(
  avatarId: string,
  memoryId: string,
  tier?: MemoryTier
): Promise<AvatarMemory | null> {
  const validAvatarId = validateAvatarId(avatarId);

  // If tier is provided, we can do a more efficient query
  if (tier) {
    const result = await getDynamoClient().send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      FilterExpression: 'id = :id',
      ExpressionAttributeValues: {
        ':pk': `MEMORY#${validAvatarId}`,
        ':prefix': `${tier}#`,
        ':id': memoryId,
      },
      Limit: 1,
    }));
    return (result.Items?.[0] as AvatarMemory) || null;
  }

  // Without tier, search all tiers
  for (const t of ['immediate', 'recent', 'core'] as MemoryTier[]) {
    const result = await getDynamoClient().send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      FilterExpression: 'id = :id',
      ExpressionAttributeValues: {
        ':pk': `MEMORY#${validAvatarId}`,
        ':prefix': `${t}#`,
        ':id': memoryId,
      },
      Limit: 1,
    }));
    if (result.Items?.[0]) {
      return result.Items[0] as AvatarMemory;
    }
  }

  return null;
}

/**
 * Get memories for an avatar with optional filters
 *
 * @param avatarId - The avatar's unique identifier
 * @param options - Query options (tier, type, filters, limit)
 * @returns Array of matching memories, newest first
 */
export async function getMemories(
  avatarId: string,
  options: MemoryQueryOptions = {}
): Promise<AvatarMemory[]> {
  const validAvatarId = validateAvatarId(avatarId);
  const { tier, limit = 100, minStrength = 0 } = options;

  // Cap limit to prevent excessive reads
  const safeLimit = Math.min(limit, 500);

  // Build key condition
  let keyCondition = 'pk = :pk';
  const expressionValues: Record<string, unknown> = {
    ':pk': `MEMORY#${validAvatarId}`,
  };

  if (tier) {
    keyCondition += ' AND begins_with(sk, :tier)';
    expressionValues[':tier'] = `${tier}#`;
  }

  // Build filter expression
  const filterParts: string[] = [];
  const expressionNames: Record<string, string> = {};

  if (options.type) {
    filterParts.push('#memtype = :type');
    expressionNames['#memtype'] = 'type';
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

  try {
    const result = await getDynamoClient().send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: keyCondition,
      ExpressionAttributeValues: expressionValues,
      ...(filterParts.length > 0 ? {
        FilterExpression: filterParts.join(' AND '),
        ExpressionAttributeNames: expressionNames,
      } : {}),
      ScanIndexForward: false, // Newest first
      Limit: safeLimit,
    }));

    return (result.Items || []) as AvatarMemory[];
  } catch (error) {
    logger.error('Failed to get memories', {
      event: 'memory_query_error',
      avatarId: validAvatarId,
      tier,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return [];
  }
}

/**
 * Get memory counts by tier (parallelized)
 *
 * @param avatarId - The avatar's unique identifier
 * @returns Object with counts per tier
 */
export async function getMemoryCounts(avatarId: string): Promise<Record<MemoryTier, number>> {
  const validAvatarId = validateAvatarId(avatarId);

  // Run all three queries in parallel
  const [immediateResult, recentResult, coreResult] = await Promise.all([
    getDynamoClient().send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :tier)',
      ExpressionAttributeValues: {
        ':pk': `MEMORY#${validAvatarId}`,
        ':tier': 'immediate#',
      },
      Select: 'COUNT',
    })),
    getDynamoClient().send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :tier)',
      ExpressionAttributeValues: {
        ':pk': `MEMORY#${validAvatarId}`,
        ':tier': 'recent#',
      },
      Select: 'COUNT',
    })),
    getDynamoClient().send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :tier)',
      ExpressionAttributeValues: {
        ':pk': `MEMORY#${validAvatarId}`,
        ':tier': 'core#',
      },
      Select: 'COUNT',
    })),
  ]);

  return {
    immediate: immediateResult.Count || 0,
    recent: recentResult.Count || 0,
    core: coreResult.Count || 0,
  };
}

/**
 * Update memory strength (for reinforcement)
 * Strength is capped at MAX_STRENGTH to prevent unbounded growth
 *
 * @param avatarId - The avatar's unique identifier
 * @param memoryId - The memory's unique identifier (for logging)
 * @param sk - The sort key of the memory
 * @param boost - Amount to increase strength by
 */
export async function reinforceMemory(
  avatarId: string,
  memoryId: string,
  sk: string,
  boost: number = DEFAULT_CONFIG.reinforcementBoost
): Promise<void> {
  const validAvatarId = validateAvatarId(avatarId);

  try {
    await getDynamoClient().send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `MEMORY#${validAvatarId}`,
        sk,
      },
      // Cap strength at MAX_STRENGTH
      UpdateExpression: 'SET strength = if_not_exists(strength, :one) + :boost, updatedAt = :now',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: {
        ':boost': Math.min(boost, MAX_STRENGTH - 1), // Prevent exceeding max in one boost
        ':one': 1.0,
        ':now': Date.now(),
      },
    }));

    // Cap the strength if it exceeded MAX_STRENGTH
    await getDynamoClient().send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `MEMORY#${validAvatarId}`,
        sk,
      },
      UpdateExpression: 'SET strength = :max',
      ConditionExpression: 'strength > :max',
      ExpressionAttributeValues: {
        ':max': MAX_STRENGTH,
      },
    })).catch(() => {
      // Ignore condition check failure - strength was already <= MAX_STRENGTH
    });

    logger.info('Memory reinforced', {
      event: 'memory_reinforced',
      avatarId: validAvatarId,
      memoryId,
      boost,
    });
  } catch (error) {
    // Log but don't throw - reinforcement failure shouldn't break the caller
    logger.warn('Failed to reinforce memory', {
      event: 'memory_reinforce_error',
      avatarId: validAvatarId,
      memoryId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Delete a single memory
 *
 * @param avatarId - The avatar's unique identifier
 * @param sk - The sort key of the memory to delete
 */
export async function deleteMemory(avatarId: string, sk: string): Promise<void> {
  const validAvatarId = validateAvatarId(avatarId);

  try {
    await getDynamoClient().send(new DeleteCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `MEMORY#${validAvatarId}`,
        sk,
      },
    }));
  } catch (error) {
    logger.error('Failed to delete memory', {
      event: 'memory_delete_error',
      avatarId: validAvatarId,
      sk,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

/**
 * Delete multiple memories (batch operation)
 * Handles DynamoDB's 25-item batch limit automatically
 *
 * @param avatarId - The avatar's unique identifier
 * @param sks - Array of sort keys to delete
 */
export async function deleteMemories(avatarId: string, sks: string[]): Promise<void> {
  if (sks.length === 0) return;

  const validAvatarId = validateAvatarId(avatarId);

  // DynamoDB batch write limit is 25
  const batches: string[][] = [];
  for (let i = 0; i < sks.length; i += 25) {
    batches.push(sks.slice(i, i + 25));
  }

  const errors: Error[] = [];

  for (const batch of batches) {
    try {
      await getDynamoClient().send(new BatchWriteCommand({
        RequestItems: {
          [ADMIN_TABLE]: batch.map(sk => ({
            DeleteRequest: {
              Key: {
                pk: `MEMORY#${validAvatarId}`,
                sk,
              },
            },
          })),
        },
      }));
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error('Unknown error'));
    }
  }

  if (errors.length > 0) {
    logger.error('Some batch deletes failed', {
      event: 'memory_batch_delete_error',
      avatarId: validAvatarId,
      totalBatches: batches.length,
      failedBatches: errors.length,
    });
  }
}

// ============================================================================
// Memory Query Helpers
// ============================================================================

/**
 * Get memories about a specific topic/person
 *
 * @param avatarId - The avatar's unique identifier
 * @param about - The topic or person to search for
 * @param limit - Maximum number of results
 * @returns Array of matching memories
 */
export async function recallAbout(
  avatarId: string,
  about: string,
  limit: number = 10
): Promise<AvatarMemory[]> {
  const validAvatarId = validateAvatarId(avatarId);
  const safeLimit = Math.min(limit, 50);

  // Query with filter - over-fetch to account for filtering
  const result = await getDynamoClient().send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk',
    FilterExpression: 'about = :about',
    ExpressionAttributeValues: {
      ':pk': `MEMORY#${validAvatarId}`,
      ':about': about.trim(),
    },
    ScanIndexForward: false,
    Limit: safeLimit * 3,
  }));

  return ((result.Items || []) as AvatarMemory[]).slice(0, safeLimit);
}

/**
 * Search memories with semantic understanding
 *
 * Hybrid scoring formula (from cosyworld research):
 *   score = (0.55 × semantic_similarity) +
 *           (0.25 × recency_score) +
 *           (0.15 × strength) +
 *           (0.05 × about_match_bonus)
 *
 * Falls back to keyword-only search if embeddings unavailable.
 *
 * @param avatarId - The avatar's unique identifier
 * @param query - Search query string
 * @param limit - Maximum number of results
 * @param options - Search options (semanticSearch, minSimilarity)
 * @returns Array of matching memories, sorted by relevance
 */
export async function searchMemories(
  avatarId: string,
  query: string,
  limit: number = 10,
  options: {
    semanticSearch?: boolean;
    minSimilarity?: number;
  } = {}
): Promise<AvatarMemory[]> {
  const validAvatarId = validateAvatarId(avatarId);
  const queryLower = query.toLowerCase().trim();
  const safeLimit = Math.min(limit, 50);
  const { semanticSearch = true, minSimilarity = 0.3 } = options;

  if (queryLower.length === 0) {
    return [];
  }

  // Generate query embedding for semantic search
  let queryEmbedding: number[] | null = null;
  if (semanticSearch) {
    try {
      const embeddingService = getEmbeddingService();
      queryEmbedding = await embeddingService.embed(query);
    } catch (error) {
      logger.warn('Failed to generate query embedding, falling back to keyword search', {
        event: 'embedding_query_error',
        avatarId: validAvatarId,
        error: error instanceof Error ? error.message : 'Unknown',
      });
    }
  }

  // Fetch candidate memories
  const result = await getDynamoClient().send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: {
      ':pk': `MEMORY#${validAvatarId}`,
    },
    ScanIndexForward: false,
    Limit: 200, // Cap initial fetch
  }));

  const memories = (result.Items || []) as AvatarMemory[];
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  // Score memories with hybrid formula
  const scored = memories
    .map(m => {
      let semanticScore = 0;
      let keywordScore = 0;

      // Semantic similarity (if embeddings available)
      if (queryEmbedding && m.embedding) {
        semanticScore = cosineSimilarity(queryEmbedding, m.embedding);
      }

      // Keyword matching (fallback/boost)
      const contentLower = m.content.toLowerCase();
      const aboutLower = (m.about || '').toLowerCase();

      if (aboutLower === queryLower) keywordScore = 1.0;
      else if (aboutLower.includes(queryLower)) keywordScore = 0.7;
      else if (contentLower.includes(queryLower)) keywordScore = 0.5;
      else if (m.themes?.some(t => t.toLowerCase().includes(queryLower))) keywordScore = 0.3;

      // Determine primary relevance signal
      const hasSemanticMatch = queryEmbedding && m.embedding && semanticScore >= minSimilarity;
      const hasKeywordMatch = keywordScore > 0;

      // Skip if no relevance signal
      if (!hasSemanticMatch && !hasKeywordMatch) {
        return { memory: m, score: 0 };
      }

      // Recency score (exponential decay over 30 days)
      const ageMs = now - m.createdAt;
      const ageDays = ageMs / dayMs;
      const recencyScore = Math.exp(-ageDays / 30);

      // About field exact match bonus
      const aboutBonus = aboutLower === queryLower ? 1.0 :
                         aboutLower.includes(queryLower) ? 0.5 : 0;

      // Hybrid scoring formula
      // If we have semantic embeddings, use them; otherwise fall back to keyword
      const semanticComponent = hasSemanticMatch
        ? semanticScore
        : keywordScore; // Fall back to keyword if no embedding

      const score = (0.55 * semanticComponent) +
                    (0.25 * recencyScore) +
                    (0.15 * m.strength) +
                    (0.05 * aboutBonus);

      // Tier multiplier
      const tierMultiplier = m.tier === 'core' ? 1.3 :
                             m.tier === 'recent' ? 1.1 : 1.0;

      return { memory: m, score: score * tierMultiplier };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, safeLimit);

  logger.info('Memory search completed', {
    event: 'memory_search',
    avatarId: validAvatarId,
    query: query.slice(0, 50),
    usedSemanticSearch: !!queryEmbedding,
    candidateCount: memories.length,
    resultCount: scored.length,
  });

  return scored.map(({ memory }) => memory);
}

/**
 * Get core memories (identity, learnings, patterns)
 *
 * @param avatarId - The avatar's unique identifier
 * @returns Array of core memories
 */
export async function getCoreMemories(avatarId: string): Promise<AvatarMemory[]> {
  return getMemories(avatarId, {
    tier: 'core',
    minStrength: DEFAULT_CONFIG.pruneThreshold,
    limit: DEFAULT_CONFIG.coreMaxCount,
  });
}

/**
 * Get identity statements
 *
 * @param avatarId - The avatar's unique identifier
 * @returns Array of identity memories
 */
export async function getIdentity(avatarId: string): Promise<AvatarMemory[]> {
  return getMemories(avatarId, {
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
 * Uses batch updates for efficiency
 *
 * @param avatarId - The avatar's unique identifier
 * @param tier - The memory tier to apply decay to
 * @param decayRate - Multiplier for strength (default: 0.95)
 * @returns Statistics about the decay operation
 */
export async function applyDecay(
  avatarId: string,
  tier: MemoryTier,
  decayRate: number = DEFAULT_CONFIG.decayRate
): Promise<{ decayed: number; pruned: number }> {
  const validAvatarId = validateAvatarId(avatarId);
  const memories = await getMemories(validAvatarId, { tier, limit: 500 });

  let decayed = 0;
  let pruned = 0;
  const toPrune: string[] = [];
  const toUpdate: Array<{ sk: string; newStrength: number }> = [];

  // Calculate new strengths
  for (const memory of memories) {
    const newStrength = memory.strength * decayRate;

    if (newStrength < DEFAULT_CONFIG.pruneThreshold) {
      toPrune.push(memory.sk);
      pruned++;
    } else {
      toUpdate.push({ sk: memory.sk, newStrength });
      decayed++;
    }
  }

  // Batch update strengths (in groups of 25 for reasonable parallelism)
  const updateBatches: Array<Array<{ sk: string; newStrength: number }>> = [];
  for (let i = 0; i < toUpdate.length; i += 25) {
    updateBatches.push(toUpdate.slice(i, i + 25));
  }

  const now = Date.now();
  for (const batch of updateBatches) {
    await Promise.all(
      batch.map(({ sk, newStrength }) =>
        getDynamoClient().send(new UpdateCommand({
          TableName: ADMIN_TABLE,
          Key: { pk: `MEMORY#${validAvatarId}`, sk },
          UpdateExpression: 'SET strength = :strength, updatedAt = :now, consolidatedAt = :now',
          ExpressionAttributeValues: {
            ':strength': newStrength,
            ':now': now,
          },
        })).catch(err => {
          logger.warn('Failed to update memory strength', {
            event: 'memory_decay_update_error',
            avatarId: validAvatarId,
            sk,
            error: err instanceof Error ? err.message : 'Unknown error',
          });
        })
      )
    );
  }

  // Delete pruned memories
  if (toPrune.length > 0) {
    await deleteMemories(validAvatarId, toPrune);
  }

  logger.info('Memory decay applied', {
    event: 'memory_decay',
    avatarId: validAvatarId,
    tier,
    decayed,
    pruned,
  });

  return { decayed, pruned };
}

/**
 * Promote oldest immediate memories to recent tier
 * Uses DynamoDB transactions for atomicity
 *
 * @param avatarId - The avatar's unique identifier
 * @param maxImmediate - Maximum memories to keep in immediate tier
 * @returns Statistics about the promotion operation
 */
export async function promoteImmediateToRecent(
  avatarId: string,
  maxImmediate: number = DEFAULT_CONFIG.immediateMaxCount
): Promise<{ promoted: number }> {
  const validAvatarId = validateAvatarId(avatarId);
  const immediateMemories = await getMemories(validAvatarId, { tier: 'immediate', limit: 500 });

  if (immediateMemories.length <= maxImmediate) {
    return { promoted: 0 };
  }

  // Sort by creation time, oldest first
  const sorted = [...immediateMemories].sort((a, b) => a.createdAt - b.createdAt);
  const toPromote = sorted.slice(0, sorted.length - maxImmediate);

  let promoted = 0;

  // Process one at a time with transaction for atomicity
  // This ensures we don't lose memories if the process fails partway through
  for (const memory of toPromote) {
    const now = Date.now();
    const newId = randomUUID();
    const newMemory: AvatarMemory = {
      pk: `MEMORY#${validAvatarId}`,
      sk: `recent#${now}#${newId}`,
      id: newId,
      avatarId: validAvatarId,
      tier: 'recent',
      type: memory.type,
      content: memory.content,
      about: memory.about,
      userId: memory.userId,
      themes: memory.themes,
      strength: memory.strength * 0.9, // Slight decay on promotion
      metadata: memory.metadata,
      createdAt: now,
      updatedAt: now,
      sourceMemoryIds: [memory.id],
    };

    try {
      // Use transaction to ensure both write and delete succeed together
      const client = new DynamoDBClient({});
      await client.send(new TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: ADMIN_TABLE,
              Item: marshall(newMemory, { removeUndefinedValues: true }),
            },
          },
          {
            Delete: {
              TableName: ADMIN_TABLE,
              Key: marshall({
                pk: `MEMORY#${validAvatarId}`,
                sk: memory.sk,
              }),
            },
          },
        ],
      }));
      promoted++;
    } catch (error) {
      logger.error('Failed to promote memory', {
        event: 'memory_promotion_error',
        avatarId: validAvatarId,
        memoryId: memory.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Continue with other memories
    }
  }

  logger.info('Immediate memories promoted to recent', {
    event: 'memory_promotion',
    avatarId: validAvatarId,
    promoted,
    attempted: toPromote.length,
  });

  return { promoted };
}

/**
 * Save an identity snapshot
 *
 * @param avatarId - The avatar's unique identifier
 * @param statement - The identity statement (e.g., "I am becoming more curious")
 * @param triggeringMemories - IDs of memories that led to this identity
 * @param previousStatement - The previous identity statement for tracking evolution
 * @returns The created identity snapshot
 */
export async function saveIdentitySnapshot(
  avatarId: string,
  statement: string,
  triggeringMemories: string[],
  previousStatement?: string
): Promise<AvatarIdentitySnapshot> {
  const validAvatarId = validateAvatarId(avatarId);
  const validStatement = validateContent(statement);

  const now = Date.now();
  const snapshot: AvatarIdentitySnapshot = {
    pk: `IDENTITY#${validAvatarId}`,
    sk: `SNAPSHOT#${now}`,
    avatarId: validAvatarId,
    statement: validStatement,
    previousStatement,
    triggeringMemories,
    createdAt: now,
  };

  try {
    await getDynamoClient().send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: snapshot,
    }));

    // Also create a core memory for the identity
    await createMemory(validAvatarId, {
      tier: 'core',
      type: 'identity',
      content: validStatement,
      strength: 1.0,
      metadata: { snapshotSk: snapshot.sk },
    });

    logger.info('Identity snapshot saved', {
      event: 'identity_snapshot',
      avatarId: validAvatarId,
      statement: validStatement.slice(0, 100),
    });

    return snapshot;
  } catch (error) {
    logger.error('Failed to save identity snapshot', {
      event: 'identity_snapshot_error',
      avatarId: validAvatarId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

/**
 * Get identity history (evolution over time)
 *
 * @param avatarId - The avatar's unique identifier
 * @param limit - Maximum number of snapshots to return
 * @returns Array of identity snapshots, newest first
 */
export async function getIdentityHistory(
  avatarId: string,
  limit: number = 10
): Promise<AvatarIdentitySnapshot[]> {
  const validAvatarId = validateAvatarId(avatarId);
  const safeLimit = Math.min(limit, 50);

  const result = await getDynamoClient().send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': `IDENTITY#${validAvatarId}`,
      ':prefix': 'SNAPSHOT#',
    },
    ScanIndexForward: false,
    Limit: safeLimit,
  }));

  return (result.Items || []) as AvatarIdentitySnapshot[];
}

// ============================================================================
// High-Level Memory API (for MCP tools)
// ============================================================================

/**
 * Remember a fact (creates immediate memory, reinforces if similar exists)
 *
 * @param avatarId - The avatar's unique identifier
 * @param fact - The fact to remember
 * @param about - Who or what this fact is about
 * @param userId - Associated user ID
 * @returns Result with saved status and memory ID
 */
export async function remember(
  avatarId: string,
  fact: string,
  about?: string,
  userId?: string
): Promise<{ saved: boolean; memoryId: string; reinforced?: boolean }> {
  const validAvatarId = validateAvatarId(avatarId);
  const validFact = validateContent(fact);

  // Check for similar existing memory to reinforce
  if (about) {
    const existing = await recallAbout(validAvatarId, about, 5);
    const factLower = validFact.toLowerCase();

    const similar = existing.find(m => {
      const contentLower = m.content.toLowerCase();
      // Check for significant overlap (>50% of shorter string)
      const shorter = Math.min(factLower.length, contentLower.length);
      const overlapThreshold = Math.floor(shorter * 0.5);

      return (
        contentLower.includes(factLower.slice(0, overlapThreshold)) ||
        factLower.includes(contentLower.slice(0, overlapThreshold))
      );
    });

    if (similar) {
      await reinforceMemory(validAvatarId, similar.id, similar.sk);
      return { saved: true, memoryId: similar.id, reinforced: true };
    }
  }

  // Create new immediate memory
  const memory = await createMemory(validAvatarId, {
    tier: 'immediate',
    type: about ? 'fact' : 'event',
    content: validFact,
    about: about?.trim(),
    userId: userId?.trim(),
  });

  // Check if we need to promote memories (async, don't block)
  promoteImmediateToRecent(validAvatarId).catch(err => {
    logger.warn('Background promotion failed', {
      event: 'memory_promotion_background_error',
      avatarId: validAvatarId,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  });

  return { saved: true, memoryId: memory.id };
}

/**
 * Recall facts (searches across all tiers)
 *
 * @param avatarId - The avatar's unique identifier
 * @param query - Search query string
 * @param userId - Filter by user ID
 * @returns Array of matching facts with metadata
 */
export async function recall(
  avatarId: string,
  query: string,
  userId?: string
): Promise<{ facts: Array<{ fact: string; about?: string; timestamp: number; strength: number }> }> {
  const validAvatarId = validateAvatarId(avatarId);
  const memories = await searchMemories(validAvatarId, query, 10);

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
 * Formats memories into a human-readable string for the LLM
 *
 * @param avatarId - The avatar's unique identifier
 * @returns Formatted memory context string
 */
export async function getMemoryContext(avatarId: string): Promise<string> {
  const validAvatarId = validateAvatarId(avatarId);

  const [coreMemories, recentMemories, identity] = await Promise.all([
    getCoreMemories(validAvatarId),
    getMemories(validAvatarId, { tier: 'recent', limit: 10 }),
    getIdentity(validAvatarId),
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

  // Relationships
  const relationships = coreMemories.filter(m => m.type === 'relationship');
  if (relationships.length > 0) {
    sections.push('\n## People I Know');
    for (const mem of relationships.slice(0, 5)) {
      const aboutStr = mem.about ? ` (${mem.about})` : '';
      sections.push(`- ${mem.content}${aboutStr}`);
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

  return sections.length > 0 ? sections.join('\n') : '';
}

// ============================================================================
// Statistics & Diagnostics
// ============================================================================

/**
 * Get comprehensive memory statistics for an avatar
 *
 * @param avatarId - The avatar's unique identifier
 * @returns Memory statistics
 */
export async function getMemoryStats(avatarId: string): Promise<{
  counts: Record<MemoryTier, number>;
  totalMemories: number;
  averageStrength: Record<MemoryTier, number>;
  oldestMemory?: { tier: MemoryTier; createdAt: number };
  newestMemory?: { tier: MemoryTier; createdAt: number };
}> {
  const validAvatarId = validateAvatarId(avatarId);
  const counts = await getMemoryCounts(validAvatarId);
  const totalMemories = counts.immediate + counts.recent + counts.core;

  // Get memories for average strength calculation
  const [immediate, recent, core] = await Promise.all([
    getMemories(validAvatarId, { tier: 'immediate', limit: 100 }),
    getMemories(validAvatarId, { tier: 'recent', limit: 100 }),
    getMemories(validAvatarId, { tier: 'core', limit: 100 }),
  ]);

  const avgStrength = (memories: AvatarMemory[]) =>
    memories.length > 0
      ? memories.reduce((sum, m) => sum + m.strength, 0) / memories.length
      : 0;

  // Find oldest and newest
  const allMemories = [...immediate, ...recent, ...core];
  let oldestMemory: { tier: MemoryTier; createdAt: number } | undefined;
  let newestMemory: { tier: MemoryTier; createdAt: number } | undefined;

  for (const m of allMemories) {
    if (!oldestMemory || m.createdAt < oldestMemory.createdAt) {
      oldestMemory = { tier: m.tier, createdAt: m.createdAt };
    }
    if (!newestMemory || m.createdAt > newestMemory.createdAt) {
      newestMemory = { tier: m.tier, createdAt: m.createdAt };
    }
  }

  return {
    counts,
    totalMemories,
    averageStrength: {
      immediate: avgStrength(immediate),
      recent: avgStrength(recent),
      core: avgStrength(core),
    },
    oldestMemory,
    newestMemory,
  };
}
