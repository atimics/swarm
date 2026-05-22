import { randomUUID } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { cosineSimilarity, getEmbeddingService } from '../embeddings.js';
import { logger } from '../../utils/index.js';

/**
 * Interface for the canonical memory module used by the runtime brain service.
 * Matches the contract expected by handlers/services/brain.ts.
 */
export interface CanonicalMemoryModule {
  remember: (
    avatarId: string,
    fact: string,
    about?: string,
    userId?: string
  ) => Promise<{ saved: boolean }>;
  recall: (
    avatarId: string,
    query: string,
    userId?: string
  ) => Promise<{
    facts: Array<{
      fact: string;
      about?: string;
      timestamp: number;
      strength?: number;
    }>;
  }>;
}

const MAX_CONTENT_LENGTH = 2000;
const MAX_ABOUT_LENGTH = 100;
const DEFAULT_STRENGTH = 1.0;
const DEFAULT_RETENTION_DAYS = 30;
const SECONDS_PER_DAY = 86400;
const MAX_RECALL_RESULTS = 20;
const MAX_RECALL_CANDIDATES = 200;
const MIN_SEMANTIC_SIMILARITY = 0.3;

let _client: DynamoDBDocumentClient | null = null;

function getDynamoClient(): DynamoDBDocumentClient {
  if (!_client) {
    _client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return _client;
}

/** Test hook: inject a mock DynamoDB document client. */
export function _setDynamoClient(client: DynamoDBDocumentClient | null): void {
  _client = client;
}

function computeTtl(retentionDays: number = DEFAULT_RETENTION_DAYS): number {
  return Math.floor(Date.now() / 1000) + retentionDays * SECONDS_PER_DAY;
}

function validateAvatarId(avatarId: string): string {
  if (!avatarId || typeof avatarId !== 'string') {
    throw new Error('avatarId is required');
  }
  const trimmed = avatarId.trim();
  if (!trimmed) throw new Error('avatarId cannot be empty');
  if (trimmed.length > 100) throw new Error('avatarId too long');
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new Error('avatarId contains invalid characters');
  }
  return trimmed;
}

function validateContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) throw new Error('content is required');
  return trimmed.length > MAX_CONTENT_LENGTH
    ? trimmed.slice(0, MAX_CONTENT_LENGTH)
    : trimmed;
}

/**
 * Create a lightweight canonical memory client that writes/reads the
 * admin-api ADMIN_TABLE `MEMORY#` schema. It writes embeddings when an
 * embedding provider is available and uses them for semantic recall; graph
 * and consolidation still run separately in admin-api.
 *
 * Items written by this client are fully compatible with admin-api's
 * memory.ts `AvatarMemory` schema so both systems can read/write
 * the same data interchangeably.
 */
export function createCanonicalMemoryClient(
  tableName?: string
): CanonicalMemoryModule {
  const table = tableName || process.env.ADMIN_TABLE || '';

  if (!table) {
    throw new Error(
      'ADMIN_TABLE is required for canonical memory client. ' +
        'Set the ADMIN_TABLE environment variable or pass tableName.'
    );
  }

  return {
    async remember(
      avatarId: string,
      fact: string,
      about?: string,
      userId?: string
    ): Promise<{ saved: boolean }> {
      const validAvatarId = validateAvatarId(avatarId);
      const validContent = validateContent(fact);
      const now = Date.now();
      const id = randomUUID();

      // Attempt to generate embedding; if it fails, write memory anyway
      let embedding: number[] | undefined;
      let embeddingModel: string | undefined;

      try {
        const embeddingService = getEmbeddingService();
        const result = await embeddingService.embedText(validContent);
        embedding = result.vector;
        embeddingModel = result.model;

        logger.info('Embedding generated for memory', {
          event: 'embedding_generated',
          avatarId: validAvatarId,
          memoryId: id,
          model: embeddingModel,
          vectorDimensions: embedding.length,
        });
      } catch (error) {
        logger.warn('Failed to generate embedding for memory', {
          event: 'embedding_failed',
          avatarId: validAvatarId,
          memoryId: id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }

      const item: Record<string, unknown> = {
        pk: `MEMORY#${validAvatarId}`,
        sk: `immediate#${now}#${id}`,
        id,
        avatarId: validAvatarId,
        tier: 'immediate',
        type: about ? 'fact' : 'event',
        content: validContent,
        about: about?.trim().slice(0, MAX_ABOUT_LENGTH),
        userId: userId?.trim(),
        strength: DEFAULT_STRENGTH,
        createdAt: now,
        updatedAt: now,
        ttl: computeTtl(),
      };

      // Only add embedding fields if generation succeeded
      if (embedding) {
        item.embedding = embedding;
        item.embeddingModel = embeddingModel;
      }

      await getDynamoClient().send(
        new PutCommand({
          TableName: table,
          Item: item,
        })
      );

      return { saved: true };
    },

    async recall(
      avatarId: string,
      query: string,
      userId?: string
    ): Promise<{
      facts: Array<{
        fact: string;
        about?: string;
        timestamp: number;
        strength?: number;
      }>;
    }> {
      const validAvatarId = validateAvatarId(avatarId);
      const queryLower = query.trim().toLowerCase();

      if (!queryLower) {
        return { facts: [] };
      }

      // Fetch candidate memories (newest first via ScanIndexForward=false)
      const result = await getDynamoClient().send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: {
            ':pk': `MEMORY#${validAvatarId}`,
          },
          ScanIndexForward: false,
          Limit: MAX_RECALL_CANDIDATES,
        })
      );

      const items = (result.Items || []) as Array<{
        content: string;
        about?: string;
        userId?: string;
        createdAt: number;
        strength: number;
        embedding?: number[];
      }>;

      const scopedItems = items.filter((item) => !userId || !item.userId || item.userId === userId);
      let queryEmbedding: number[] | null = null;

      if (scopedItems.some((item) => item.embedding && item.embedding.length > 0)) {
        try {
          queryEmbedding = (await getEmbeddingService().embedText(query.trim())).vector;
        } catch (error) {
          logger.warn('Semantic canonical memory recall failed, using lexical fallback', {
            event: 'canonical_memory_semantic_recall_fallback',
            avatarId: validAvatarId,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      const matched = scopedItems
        .map((item, index) => {
          const contentMatch = item.content.toLowerCase().includes(queryLower);
          const aboutMatch = (item.about || '').toLowerCase().includes(queryLower);
          const semanticScore = queryEmbedding && item.embedding
            ? cosineSimilarity(queryEmbedding, item.embedding)
            : 0;

          return {
            item,
            index,
            lexicalMatch: contentMatch || aboutMatch,
            semanticScore,
          };
        })
        .filter(({ lexicalMatch, semanticScore }) => (
          lexicalMatch || semanticScore >= MIN_SEMANTIC_SIMILARITY
        ))
        .sort((a, b) => {
          const aSemantic = a.semanticScore >= MIN_SEMANTIC_SIMILARITY;
          const bSemantic = b.semanticScore >= MIN_SEMANTIC_SIMILARITY;
          if (aSemantic !== bSemantic) return aSemantic ? -1 : 1;
          if (aSemantic && bSemantic && a.semanticScore !== b.semanticScore) {
            return b.semanticScore - a.semanticScore;
          }
          return a.index - b.index;
        })
        .map(({ item }) => item);

      return {
        facts: matched.slice(0, MAX_RECALL_RESULTS).map((item) => ({
          fact: item.content,
          about: item.about,
          timestamp: item.createdAt,
          strength: item.strength,
        })),
      };
    },
  };
}
