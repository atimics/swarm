# Semantic Memory Search - Design Specification

**Status**: Implemented (initial)
**Priority**: High
**Estimated Effort**: 1-2 weeks (hardening + backfill)
**Author**: Internal
**Date**: 2025-01-15 (updated 2026-01-25)

## Status update (2026-01)

The core implementation described in this spec is now present in the repository:
- Embedding generation: `packages/admin-api/src/services/embedding.ts`
- Hybrid recall (semantic + recency + strength): `packages/admin-api/src/services/memory.ts`

What remains is mostly operational hardening: safe backfills for older memories, metrics/visibility into embedding coverage, and tuning thresholds for latency and relevance.

## Executive Summary

This document specifies the implementation of embedding-based semantic search for the AWS Swarm memory system. The current keyword-based search limits recall quality significantly—avatars cannot find conceptually related memories unless exact terms match. Semantic search transforms avatar intelligence by enabling meaning-based retrieval.

**Key Insight**: The hybrid scoring formula already exists in memory.ts and weights semantic similarity at 55%. This component is currently non-functional because no embeddings exist. Activating it delivers immediate, dramatic improvement to every avatar's recall quality.

## Problem Statement

### Current Limitations

```typescript
// Current searchMemories() - Line 615 of memory.ts
const result = await getDynamoClient().send(new QueryCommand({
  // ... fetches 200 items, filters client-side with substring matching
  Limit: 200,
}));
```

**Issues:**
1. **Keyword matching only** - "What do I know about velocity?" won't find "Cheetahs run at 70mph"
2. **200-item ceiling** - As memories grow, relevant older memories become unfindable
3. **No conceptual understanding** - "happy users" won't match "satisfied customers"
4. **Hybrid scoring broken** - The 55% semantic weight contributes nothing without embeddings

### Impact

Every avatar conversation that uses `recall` is degraded:
- Users ask about topics the avatar "knows" but can't retrieve
- Avatars appear forgetful despite having relevant memories
- Relationship context is lost when names are spelled differently
- Core learnings don't surface for conceptually related queries

## Solution Overview

### Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Memory Creation Flow                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  remember(fact) ──► EmbeddingService.embed(fact) ──► createMemory() │
│                           │                              │           │
│                           ▼                              ▼           │
│                    [1024-dim vector]              DynamoDB + GSI     │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                        Memory Recall Flow                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  recall(query) ──► EmbeddingService.embed(query)                     │
│                           │                                           │
│                           ▼                                           │
│                    Query DynamoDB for candidates (by tier/avatar)     │
│                           │                                           │
│                           ▼                                           │
│                    Compute cosine similarity for each                 │
│                           │                                           │
│                           ▼                                           │
│                    Apply hybrid scoring formula                       │
│                           │                                           │
│                           ▼                                           │
│                    Return top-K ranked memories                       │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Embedding Model | Bedrock Titan v2 | Already have Bedrock client, no new API key, 1024 dims |
| Storage | DynamoDB (same table) | No new infrastructure, embeddings stored as list of numbers |
| Index | None initially | Start with fetch-then-score; add GSI if latency unacceptable |
| Fallback | OpenAI via OpenRouter | If Bedrock fails, use existing OpenRouter key |
| Dimension | 1024 | Titan v2 native; good balance of quality vs storage |

## Detailed Design

### 1. Embedding Service

New service at `packages/admin-api/src/services/embedding.ts`:

```typescript
/**
 * Embedding Service - Generate vector embeddings for semantic search
 *
 * Primary: AWS Bedrock Titan Embeddings v2 (1024 dimensions)
 * Fallback: OpenAI text-embedding-3-small via OpenRouter
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { logger } from '@swarm/core';

export interface EmbeddingService {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingConfig {
  provider: 'bedrock' | 'openrouter';
  model?: string;
  dimensions?: number;
}

const DEFAULT_CONFIG: EmbeddingConfig = {
  provider: 'bedrock',
  model: 'amazon.titan-embed-text-v2:0',
  dimensions: 1024,
};

// Bedrock Titan Embeddings
export class BedrockEmbeddingService implements EmbeddingService {
  private client: BedrockRuntimeClient;
  private model: string;
  private dimensions: number;

  constructor(config: EmbeddingConfig = DEFAULT_CONFIG) {
    this.client = new BedrockRuntimeClient({ region: 'us-east-1' });
    this.model = config.model || 'amazon.titan-embed-text-v2:0';
    this.dimensions = config.dimensions || 1024;
  }

  async embed(text: string): Promise<number[]> {
    const truncated = text.slice(0, 8000); // Titan limit is 8192 tokens

    const response = await this.client.send(new InvokeModelCommand({
      modelId: this.model,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        inputText: truncated,
        dimensions: this.dimensions,
        normalize: true,
      }),
    }));

    const result = JSON.parse(new TextDecoder().decode(response.body));
    return result.embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Titan doesn't support batch, so parallelize individual calls
    // Limit concurrency to avoid throttling
    const BATCH_SIZE = 5;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const embeddings = await Promise.all(batch.map(t => this.embed(t)));
      results.push(...embeddings);
    }

    return results;
  }
}

// OpenRouter fallback (OpenAI text-embedding-3-small)
export class OpenRouterEmbeddingService implements EmbeddingService {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string = 'openai/text-embedding-3-small') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: text.slice(0, 8000),
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter embedding error: ${response.status}`);
    }

    const data = await response.json();
    return data.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts.map(t => t.slice(0, 8000)),
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter embedding error: ${response.status}`);
    }

    const data = await response.json();
    return data.data.map((d: { embedding: number[] }) => d.embedding);
  }
}

// Factory with fallback
export function createEmbeddingService(
  secrets: Record<string, string>
): EmbeddingService {
  try {
    return new BedrockEmbeddingService();
  } catch (error) {
    logger.warn('Bedrock embedding unavailable, trying OpenRouter', { error });

    const apiKey = secrets['OPENROUTER_API_KEY'];
    if (!apiKey) {
      throw new Error('No embedding service available');
    }
    return new OpenRouterEmbeddingService(apiKey);
  }
}
```

### 2. Enhanced Memory Schema

Update `packages/admin-api/src/types.ts`:

```typescript
export interface AgentMemory {
  pk: string;
  sk: string;
  id: string;
  avatarId: string;
  tier: MemoryTier;
  type: MemoryType;
  content: string;
  about?: string;
  userId?: string;
  themes?: string[];
  strength: number;

  // NEW: Embedding support
  embedding?: number[];           // 1024-dimension vector
  embeddingModel?: string;        // e.g., "amazon.titan-embed-text-v2:0"
  embeddingVersion?: number;      // For re-embedding on model upgrades

  createdAt: number;
  updatedAt: number;
  consolidatedAt?: number;
  sourceMemoryIds?: string[];
  metadata?: Record<string, unknown>;
}

// Embedding model version - increment when changing models
export const EMBEDDING_VERSION = 1;
```

### 3. Semantic Search Implementation

Update `searchMemories()` in `packages/admin-api/src/services/memory.ts`:

```typescript
import { createEmbeddingService, EmbeddingService } from './embedding.js';

// Module-level embedding service (lazy initialized)
let _embeddingService: EmbeddingService | null = null;

function getEmbeddingService(): EmbeddingService {
  if (!_embeddingService) {
    _embeddingService = createEmbeddingService({});
  }
  return _embeddingService;
}

/**
 * Cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

/**
 * Search memories with semantic understanding
 *
 * Hybrid scoring formula (from cosyworld research):
 *   score = (0.55 × semantic_similarity) +
 *           (0.25 × recency_score) +
 *           (0.15 × strength) +
 *           (0.05 × about_match_bonus)
 */
export async function searchMemories(
  avatarId: string,
  query: string,
  limit: number = 10,
  options: {
    semanticSearch?: boolean;
    minSimilarity?: number;
  } = {}
): Promise<AgentMemory[]> {
  const validAgentId = validateAgentId(avatarId);
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
      queryEmbedding = await getEmbeddingService().embed(query);
    } catch (error) {
      logger.warn('Failed to generate query embedding, falling back to keyword search', {
        event: 'embedding_error',
        error: error instanceof Error ? error.message : 'Unknown',
      });
    }
  }

  // Fetch candidate memories
  const result = await getDynamoClient().send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: {
      ':pk': `MEMORY#${validAgentId}`,
    },
    ScanIndexForward: false,
    Limit: 200,
  }));

  const memories = (result.Items || []) as AgentMemory[];
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

      // Skip if no relevance signal
      if (semanticScore < minSimilarity && keywordScore === 0) {
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
      const semanticComponent = queryEmbedding && m.embedding
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

  return scored.map(({ memory }) => memory);
}
```

### 4. Memory Creation with Embedding

Update `createMemory()`:

```typescript
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
    embedding?: number[];  // Allow pre-computed embedding
    metadata?: Record<string, unknown>;
    sourceMemoryIds?: string[];
  }
): Promise<AgentMemory> {
  const validAgentId = validateAgentId(avatarId);
  const validContent = validateContent(params.content);
  const validThemes = validateThemes(params.themes);
  const validStrength = validateStrength(params.strength);

  // Generate embedding if not provided
  let embedding = params.embedding;
  if (!embedding) {
    try {
      embedding = await getEmbeddingService().embed(validContent);
    } catch (error) {
      logger.warn('Failed to generate embedding for memory', {
        event: 'embedding_generation_error',
        avatarId: validAgentId,
        error: error instanceof Error ? error.message : 'Unknown',
      });
      // Continue without embedding - graceful degradation
    }
  }

  const now = Date.now();
  const id = randomUUID();

  const memory: AgentMemory = {
    pk: `MEMORY#${validAgentId}`,
    sk: `${params.tier}#${now}#${id}`,
    id,
    avatarId: validAgentId,
    tier: params.tier,
    type: params.type,
    content: validContent,
    about: params.about?.trim().slice(0, 100),
    userId: params.userId?.trim().slice(0, 100),
    themes: validThemes,
    strength: validStrength,
    embedding,
    embeddingModel: embedding ? 'amazon.titan-embed-text-v2:0' : undefined,
    embeddingVersion: embedding ? EMBEDDING_VERSION : undefined,
    metadata: params.metadata,
    createdAt: now,
    updatedAt: now,
    sourceMemoryIds: params.sourceMemoryIds,
  };

  await getDynamoClient().send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: memory,
  }));

  logger.info('Memory created', {
    event: 'memory_created',
    avatarId: validAgentId,
    memoryId: id,
    tier: params.tier,
    type: params.type,
    hasEmbedding: !!embedding,
  });

  return memory;
}
```

### 5. Migration Strategy for Existing Memories

New file `packages/admin-api/src/services/memory-migration.ts`:

```typescript
/**
 * Memory Migration Service
 *
 * Backfills embeddings for existing memories that lack them.
 * Designed to run as a background job or on-demand via admin chat.
 */

import { getMemories, getDynamoClient } from './memory.js';
import { createEmbeddingService } from './embedding.js';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@swarm/core';

const ADMIN_TABLE = process.env.ADMIN_TABLE || 'swarm-admin-table';
const EMBEDDING_VERSION = 1;

export interface MigrationResult {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

/**
 * Backfill embeddings for an avatar's memories
 */
export async function backfillEmbeddings(
  avatarId: string,
  options: {
    batchSize?: number;
    dryRun?: boolean;
    forceRegenerate?: boolean;
  } = {}
): Promise<MigrationResult> {
  const { batchSize = 10, dryRun = false, forceRegenerate = false } = options;
  const embeddingService = createEmbeddingService({});

  const result: MigrationResult = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  // Get all memories for the avatar
  const memories = await getMemories(avatarId, { limit: 500 });

  // Filter to memories needing embeddings
  const needsEmbedding = memories.filter(m => {
    if (forceRegenerate) return true;
    if (!m.embedding) return true;
    if (m.embeddingVersion !== EMBEDDING_VERSION) return true;
    return false;
  });

  logger.info('Starting embedding backfill', {
    event: 'embedding_backfill_start',
    avatarId,
    totalMemories: memories.length,
    needsEmbedding: needsEmbedding.length,
    dryRun,
  });

  // Process in batches
  for (let i = 0; i < needsEmbedding.length; i += batchSize) {
    const batch = needsEmbedding.slice(i, i + batchSize);

    for (const memory of batch) {
      result.processed++;

      if (dryRun) {
        result.skipped++;
        continue;
      }

      try {
        const embedding = await embeddingService.embed(memory.content);

        await getDynamoClient().send(new UpdateCommand({
          TableName: ADMIN_TABLE,
          Key: { pk: memory.pk, sk: memory.sk },
          UpdateExpression: 'SET embedding = :emb, embeddingModel = :model, embeddingVersion = :ver, updatedAt = :now',
          ExpressionAttributeValues: {
            ':emb': embedding,
            ':model': 'amazon.titan-embed-text-v2:0',
            ':ver': EMBEDDING_VERSION,
            ':now': Date.now(),
          },
        }));

        result.succeeded++;
      } catch (error) {
        result.failed++;
        logger.warn('Failed to backfill embedding', {
          event: 'embedding_backfill_error',
          avatarId,
          memoryId: memory.id,
          error: error instanceof Error ? error.message : 'Unknown',
        });
      }
    }

    // Rate limiting - pause between batches
    if (i + batchSize < needsEmbedding.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  logger.info('Embedding backfill complete', {
    event: 'embedding_backfill_complete',
    avatarId,
    ...result,
  });

  return result;
}

/**
 * Check embedding coverage for an avatar
 */
export async function getEmbeddingStats(avatarId: string): Promise<{
  total: number;
  withEmbedding: number;
  withoutEmbedding: number;
  outdatedEmbedding: number;
  coveragePercent: number;
}> {
  const memories = await getMemories(avatarId, { limit: 500 });

  let withEmbedding = 0;
  let outdatedEmbedding = 0;

  for (const m of memories) {
    if (m.embedding) {
      if (m.embeddingVersion === EMBEDDING_VERSION) {
        withEmbedding++;
      } else {
        outdatedEmbedding++;
      }
    }
  }

  return {
    total: memories.length,
    withEmbedding,
    withoutEmbedding: memories.length - withEmbedding - outdatedEmbedding,
    outdatedEmbedding,
    coveragePercent: memories.length > 0
      ? Math.round((withEmbedding / memories.length) * 100)
      : 100,
  };
}
```

### 6. Admin Chat Tool

Add to chat handler for on-demand migration:

```typescript
// In packages/admin-api/src/handlers/chat.ts

{
  name: 'backfill_embeddings',
  description: 'Generate embeddings for memories that lack them. Enables semantic search.',
  parameters: z.object({
    avatarId: z.string().optional().describe('Avatar ID (defaults to current avatar)'),
    dryRun: z.boolean().optional().describe('Preview what would be migrated'),
  }),
  execute: async ({ avatarId, dryRun }, context) => {
    const targetAgent = avatarId || context.avatarId;
    if (!targetAgent) {
      return { error: 'No avatar selected' };
    }

    const stats = await getEmbeddingStats(targetAgent);

    if (dryRun) {
      return {
        message: `Would process ${stats.withoutEmbedding + stats.outdatedEmbedding} memories`,
        stats,
      };
    }

    const result = await backfillEmbeddings(targetAgent);
    return {
      message: `Backfill complete: ${result.succeeded} succeeded, ${result.failed} failed`,
      result,
    };
  },
}
```

## Cost Analysis

### Embedding Costs (Bedrock Titan v2)

| Metric | Value |
|--------|-------|
| Price per 1M input tokens | $0.02 |
| Average memory size | ~100 tokens |
| Cost per 1000 memories | $0.002 |
| Cost for 10K memories | $0.02 |
| Monthly estimate (active avatar) | ~$0.10 |

### Storage Costs (DynamoDB)

| Metric | Value |
|--------|-------|
| Embedding size | 1024 floats × 8 bytes = 8KB |
| Per memory overhead | ~8.5KB (with metadata) |
| 1000 memories | ~8.5MB |
| DynamoDB storage cost | $0.25/GB/month |
| Monthly for 10K memories | ~$0.02 |

**Total marginal cost**: ~$0.12/month per active avatar (negligible)

## Performance Considerations

### Latency

| Operation | Current | With Embeddings |
|-----------|---------|-----------------|
| Memory create | ~50ms | ~150ms (+embedding) |
| Memory search | ~100ms | ~200ms (+similarity) |

The 100ms increase for search is acceptable for the quality improvement. For create, the embedding generation can be made async if needed.

### Scalability

Current design retrieves 200 candidates then scores. For avatars with 1000+ memories:

**Phase 1 (this design)**: Adequate for most avatars
**Phase 2 (future)**: Add DynamoDB GSI on `embedding` for approximate nearest neighbor, or migrate to purpose-built vector store (Pinecone, Qdrant)

## Testing Plan

### Unit Tests

```typescript
// packages/admin-api/src/services/embedding.test.ts

describe('EmbeddingService', () => {
  it('generates 1024-dimensional vectors', async () => {
    const service = new BedrockEmbeddingService();
    const embedding = await service.embed('test text');
    expect(embedding).toHaveLength(1024);
  });

  it('produces similar vectors for similar text', async () => {
    const service = new BedrockEmbeddingService();
    const e1 = await service.embed('The cheetah runs fast');
    const e2 = await service.embed('Cheetahs are speedy animals');
    const e3 = await service.embed('The weather is nice today');

    const sim12 = cosineSimilarity(e1, e2);
    const sim13 = cosineSimilarity(e1, e3);

    expect(sim12).toBeGreaterThan(0.7); // High similarity
    expect(sim13).toBeLessThan(0.5);    // Low similarity
  });
});

describe('searchMemories (semantic)', () => {
  it('finds conceptually related memories', async () => {
    await createMemory(testAgentId, {
      tier: 'immediate',
      type: 'fact',
      content: 'Cheetahs can reach speeds of 70 mph',
    });

    const results = await searchMemories(testAgentId, 'fast animals');
    expect(results[0].content).toContain('Cheetah');
  });

  it('falls back to keyword search without embeddings', async () => {
    const results = await searchMemories(testAgentId, 'cheetah', 10, {
      semanticSearch: false,
    });
    expect(results).toBeDefined();
  });
});
```

### Integration Tests

1. Create avatar with memory enabled
2. Remember 10 diverse facts
3. Query with conceptually related terms
4. Verify recall quality vs keyword-only baseline

## Rollout Plan

### Phase 1: Shadow Mode (Week 1)

1. Deploy embedding service
2. Generate embeddings on new memories (don't use for search yet)
3. Monitor embedding quality and latency
4. Backfill existing memories in background

### Phase 2: Gradual Activation (Week 2)

1. Enable semantic search for new avatars
2. A/B test recall quality (log both keyword and semantic scores)
3. Tune similarity threshold based on real data
4. Enable for all avatars

### Metrics to Track

- Embedding generation success rate
- Average semantic similarity scores
- Search latency p50/p95/p99
- User satisfaction (qualitative)

## Open Questions

1. **Embedding caching**: Should we cache query embeddings for repeated searches?
   - Recommendation: Not initially, add if latency is a problem

2. **Multi-field embedding**: Embed `content` only, or concat `content + about + themes`?
   - Recommendation: Start with content only, iterate based on quality

3. **Embedding refresh**: When to re-embed on model upgrades?
   - Recommendation: Track `embeddingVersion`, backfill lazily

## Appendix: Alternative Approaches Considered

### A. Dedicated Vector Database (Pinecone/Qdrant)

**Pros**: Purpose-built for vector search, scales infinitely
**Cons**: New infrastructure, additional cost, data sync complexity
**Verdict**: Overkill for current scale; revisit if avatars exceed 10K memories

### B. OpenSearch with k-NN

**Pros**: AWS-native, combines full-text and vector search
**Cons**: Significant infrastructure cost (~$100/month minimum)
**Verdict**: Consider for Phase 2 if DynamoDB approach hits limits

### C. Client-side embeddings (transformers.js)

**Pros**: No API costs, no latency
**Cons**: Model quality, bundle size, compute on Lambda
**Verdict**: Not suitable for serverless architecture

---

## Summary

This design adds semantic memory search by:
1. Creating an `EmbeddingService` using Bedrock Titan v2
2. Generating embeddings on memory creation
3. Implementing cosine similarity scoring in `searchMemories()`
4. Providing migration tooling for existing memories
5. Maintaining full backward compatibility (graceful degradation)

The implementation is focused, cost-effective (~$0.12/avatar/month), and delivers immediate value by activating the already-designed hybrid scoring formula.
