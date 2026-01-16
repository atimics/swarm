/**
 * Memory Tools
 *
 * Tools for remembering and recalling facts about users and conversations.
 * This enables agents to build persistent memory across interactions.
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

/**
 * Fact stored in memory
 */
export interface MemoryFact {
  fact: string;
  about?: string;
  userId?: string;
  timestamp: number;
  strength?: number;
}

/**
 * Embedding statistics for an agent's memories
 */
export interface EmbeddingStats {
  total: number;
  withEmbedding: number;
  withoutEmbedding: number;
  outdatedEmbedding: number;
  coveragePercent: number;
}

/**
 * Result of backfilling embeddings
 */
export interface BackfillResult {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

/**
 * Memory services required by these tools
 */
export interface MemoryServices {
  /**
   * Save a fact to memory
   */
  remember: (fact: string, about?: string, userId?: string) => Promise<{ saved: boolean }>;

  /**
   * Recall facts from memory
   */
  recall: (query: string, userId?: string) => Promise<{ facts: MemoryFact[] }>;

  /**
   * Get embedding statistics for an agent (optional)
   */
  getEmbeddingStats?: () => Promise<EmbeddingStats>;

  /**
   * Backfill embeddings for memories that lack them (optional)
   */
  backfillEmbeddings?: (options?: { dryRun?: boolean }) => Promise<BackfillResult>;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createMemoryTools = (memory: MemoryServices) => [
  defineTool({
    name: 'remember',
    description: 'Save an important fact about a user or topic to remember for future conversations. Use this to build persistent memory about users, their preferences, and important details.',
    category: 'readonly',
    toolset: 'memory',
    inputSchema: z.object({
      fact: z.string().min(1).describe('The fact to remember (e.g., "User prefers dark themes" or "Alice\'s birthday is March 15")'),
      about: z.string().optional().describe('Who or what this fact is about (e.g., username, topic, or "general")'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        const result = await memory.remember(input.fact, input.about, context.userId);
        return {
          success: true,
          data: {
            saved: result.saved,
            message: 'Fact saved to memory',
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to save fact',
        };
      }
    },
  }),

  defineTool({
    name: 'recall',
    description: 'Search your memory for previously saved facts about a user or topic. Use this to remember things about users before responding.',
    category: 'readonly',
    toolset: 'memory',
    inputSchema: z.object({
      query: z.string().min(1).describe('What to search for (e.g., a username, topic, or keyword)'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        const result = await memory.recall(input.query, context.userId);
        
        if (result.facts.length === 0) {
          return {
            success: true,
            data: {
              found: false,
              message: `No facts found about "${input.query}"`,
              facts: [],
            },
          };
        }

        return {
          success: true,
          data: {
            found: true,
            count: result.facts.length,
            facts: result.facts.map(f => ({
              fact: f.fact,
              about: f.about,
              strength: f.strength,
              savedAt: new Date(f.timestamp).toISOString(),
            })),
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to recall facts',
        };
      }
    },
  }),

  // Admin tools for managing memory embeddings
  defineTool({
    name: 'memory_stats',
    description: 'Get statistics about memory embedding coverage. Shows how many memories have semantic embeddings enabled.',
    category: 'config',
    toolset: 'memory',
    inputSchema: z.object({}),
    execute: async (_input, _context): Promise<ToolResult> => {
      try {
        if (!memory.getEmbeddingStats) {
          return {
            success: false,
            error: 'Embedding stats not available for this agent',
          };
        }

        const stats = await memory.getEmbeddingStats();
        return {
          success: true,
          data: {
            total: stats.total,
            withEmbedding: stats.withEmbedding,
            withoutEmbedding: stats.withoutEmbedding,
            outdatedEmbedding: stats.outdatedEmbedding,
            coveragePercent: stats.coveragePercent,
            message: stats.coveragePercent === 100
              ? 'All memories have current embeddings'
              : `${stats.withoutEmbedding + stats.outdatedEmbedding} memories need embedding updates`,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get memory stats',
        };
      }
    },
  }),

  defineTool({
    name: 'backfill_embeddings',
    description: 'Generate embeddings for memories that lack them. This enables semantic search for better recall quality.',
    category: 'config',
    toolset: 'memory',
    inputSchema: z.object({
      dryRun: z.boolean().optional().describe('If true, only show what would be processed without making changes'),
    }),
    execute: async (input, _context): Promise<ToolResult> => {
      try {
        if (!memory.backfillEmbeddings) {
          return {
            success: false,
            error: 'Embedding backfill not available for this agent',
          };
        }

        const result = await memory.backfillEmbeddings({ dryRun: input.dryRun });

        if (input.dryRun) {
          return {
            success: true,
            data: {
              dryRun: true,
              wouldProcess: result.processed,
              message: `Would process ${result.processed} memories (dry run)`,
            },
          };
        }

        return {
          success: true,
          data: {
            processed: result.processed,
            succeeded: result.succeeded,
            failed: result.failed,
            skipped: result.skipped,
            message: result.failed > 0
              ? `Processed ${result.processed} memories: ${result.succeeded} succeeded, ${result.failed} failed`
              : `Successfully processed ${result.succeeded} memories`,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to backfill embeddings',
        };
      }
    },
  }),
];
