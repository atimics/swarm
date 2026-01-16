/**
 * Claude Code Integration Tools
 *
 * Tools for executing complex coding tasks using Claude Code avatar.
 * Uses async job queue pattern similar to media generation.
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

// ============================================================================
// Types
// ============================================================================

export type ClaudeCodeJobStatus =
  | 'pending'
  | 'processing'
  | 'waiting_input'
  | 'completed'
  | 'failed';

export interface ClaudeCodeJob {
  jobId: string;
  avatarId: string;
  conversationId?: string;
  status: ClaudeCodeJobStatus;
  task: string;
  workingDir: string;
  sessionId?: string;
  result?: string;
  error?: string;
  pendingQuestion?: {
    text: string;
    options: Array<{ label: string; description: string }>;
  };
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface ClaudeCodeServices {
  /**
   * Enqueue a new Claude Code task
   */
  enqueueTask: (params: {
    avatarId: string;
    conversationId?: string;
    replyToMessageId?: string;
    task: string;
    workingDir?: string;
    maxTurns?: number;
    sessionId?: string;
    allowedTools?: string[];
  }) => Promise<{ jobId: string }>;

  /**
   * Respond to a pending question from Claude Code
   */
  respondToQuestion: (params: {
    avatarId: string;
    jobId: string;
    sessionId: string;
    response: string;
  }) => Promise<void>;

  /**
   * Get job status
   */
  getJob: (avatarId: string, jobId: string) => Promise<ClaudeCodeJob | null>;

  /**
   * Get all pending/active jobs for an avatar
   */
  getActiveJobs: (avatarId: string) => Promise<ClaudeCodeJob[]>;

  /**
   * Cancel a running job
   */
  cancelJob?: (avatarId: string, jobId: string) => Promise<boolean>;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createClaudeCodeTools = (services: ClaudeCodeServices) => [
  defineTool({
    name: 'claude_code_execute',
    description: `Execute a complex coding task using Claude Code avatar. Use this for:
- Multi-file code generation or refactoring
- Debugging and fixing complex bugs
- Code analysis and review
- Creating new features that span multiple files
- Running tests and fixing failures

The task runs asynchronously. Use get_claude_code_job to check status.`,
    category: 'config',
    toolset: 'core',
    tags: [],
    inputSchema: z.object({
      task: z.string().describe('Detailed description of the coding task to perform'),
      workingDir: z
        .string()
        .optional()
        .default('/workspace')
        .describe('Working directory for the task'),
      maxTurns: z
        .number()
        .optional()
        .default(30)
        .describe('Maximum number of avatar turns (default: 30)'),
      sessionId: z
        .string()
        .optional()
        .describe('Resume an existing session by ID'),
      allowedTools: z
        .array(z.string())
        .optional()
        .describe('Specific tools to allow (default: Read, Edit, Write, Bash, Glob, Grep)'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        const { jobId } = await services.enqueueTask({
          avatarId: context.avatarId,
          conversationId: context.conversationId,
          replyToMessageId: context.replyToMessageId,
          task: input.task,
          workingDir: input.workingDir,
          maxTurns: input.maxTurns,
          sessionId: input.sessionId,
          allowedTools: input.allowedTools,
        });

        return {
          success: true,
          data: {
            jobId,
            status: 'pending',
            message: 'Claude Code task queued. Use get_claude_code_job to check status.',
          },
          pendingJob: {
            jobId,
            type: 'property_research', // Reuse existing type for UI compatibility
            status: 'processing',
            purpose: 'claude_code',
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to queue task',
        };
      }
    },
  }),

  defineTool({
    name: 'claude_code_respond',
    description:
      'Respond to a pending question from Claude Code. Use this when a Claude Code job has status "waiting_input".',
    category: 'config',
    toolset: 'core',
    inputSchema: z.object({
      jobId: z.string().describe('The job ID that is waiting for input'),
      sessionId: z.string().describe('The session ID from the job'),
      response: z.string().describe('Your response to the question'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        await services.respondToQuestion({
          avatarId: context.avatarId,
          jobId: input.jobId,
          sessionId: input.sessionId,
          response: input.response,
        });

        return {
          success: true,
          data: {
            jobId: input.jobId,
            message: 'Response sent. Claude Code will continue processing.',
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to send response',
        };
      }
    },
  }),

  defineTool({
    name: 'get_claude_code_job',
    description: 'Get the status of a Claude Code job.',
    category: 'readonly',
    toolset: 'core',
    inputSchema: z.object({
      jobId: z.string().describe('The job ID to check'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      const job = await services.getJob(context.avatarId, input.jobId);

      if (!job) {
        return { success: false, error: 'Job not found' };
      }

      const result: ToolResult = {
        success: true,
        data: {
          jobId: job.jobId,
          status: job.status,
          task: job.task.slice(0, 100) + (job.task.length > 100 ? '...' : ''),
          sessionId: job.sessionId,
          result: job.result,
          error: job.error,
          pendingQuestion: job.pendingQuestion,
          createdAt: new Date(job.createdAt).toISOString(),
          completedAt: job.completedAt
            ? new Date(job.completedAt).toISOString()
            : undefined,
        },
      };

      // If job is waiting for input, include the question in the response
      if (job.status === 'waiting_input' && job.pendingQuestion) {
        (result.data as Record<string, unknown>).needsInput = true;
        (result.data as Record<string, unknown>).question = job.pendingQuestion.text;
        (result.data as Record<string, unknown>).options = job.pendingQuestion.options;
      }

      return result;
    },
  }),

  defineTool({
    name: 'get_claude_code_jobs',
    description: 'List all active Claude Code jobs.',
    category: 'readonly',
    toolset: 'core',
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      const jobs = await services.getActiveJobs(context.avatarId);

      return {
        success: true,
        data: {
          jobs: jobs.map((job) => ({
            jobId: job.jobId,
            status: job.status,
            task: job.task.slice(0, 50) + (job.task.length > 50 ? '...' : ''),
            sessionId: job.sessionId,
            needsInput: job.status === 'waiting_input',
            createdAt: new Date(job.createdAt).toISOString(),
          })),
          count: jobs.length,
        },
      };
    },
  }),

  ...(services.cancelJob
    ? [
        defineTool({
          name: 'cancel_claude_code_job',
          description: 'Cancel a running Claude Code job.',
          category: 'config',
          toolset: 'core',
          inputSchema: z.object({
            jobId: z.string().describe('The job ID to cancel'),
          }),
          execute: async (input, context): Promise<ToolResult> => {
            const cancelled = await services.cancelJob!(context.avatarId, input.jobId);

            if (cancelled) {
              return {
                success: true,
                data: { message: 'Job cancelled successfully' },
              };
            }

            return {
              success: false,
              error: 'Failed to cancel job (may already be completed)',
            };
          },
        }),
      ]
    : []),
];

export default createClaudeCodeTools;
