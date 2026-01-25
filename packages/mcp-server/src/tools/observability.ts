/**
 * Observability Tools
 *
 * Tools for querying system status and per-avatar activity.
 */
import { z } from 'zod';
import { defineTool, type ToolResult, type ToolContext } from '../registry.js';

export interface SystemStatusResult {
  timestamp: number;
  window: { since: number; until: number };
  errors: { errorCount: number; warnCount: number; truncated: boolean };
  autoIssues: { openTotal: number; bySeverity: Record<string, number>; sampled: boolean; sampleLimit: number };
  queues: Record<string, unknown>;
  toolCredits?: Record<string, unknown>;
  energy?: Record<string, unknown>;
  rateLimit?: Record<string, unknown>;
}

export interface AvatarActivityResult {
  avatarId: string;
  window: { since: number; until: number };
  items: Array<Record<string, unknown>>;
  summary: {
    errorCount: number;
    warnCount: number;
    issueCount: number;
    feedbackCount: number;
    pendingJobs: number;
  };
}

export interface ObservabilityServices {
  getSystemStatus: (options: { since?: number; avatarId?: string }) => Promise<SystemStatusResult>;
  getAvatarActivity: (avatarId: string, options?: { since?: number; limit?: number }) => Promise<AvatarActivityResult>;
}

function parseSinceInput(raw?: string): number | undefined {
  if (!raw) return undefined;
  const match = raw.trim().match(/^(\d+)(m|h|d)$/i);
  if (match) {
    const value = Number.parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const ms = unit === 'm'
      ? value * 60 * 1000
      : unit === 'h'
        ? value * 60 * 60 * 1000
        : unit === 'd'
          ? value * 24 * 60 * 60 * 1000
          : 0;
    return Date.now() - ms;
  }
  const numeric = Number.parseInt(raw, 10);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function canAccessAvatar(context: ToolContext, avatarId: string): boolean {
  if (context.session?.isAdmin) return true;
  if (context.sender?.inhabitedAvatarId && context.sender.inhabitedAvatarId === avatarId) return true;
  return false;
}

export function createObservabilityTools(services: ObservabilityServices) {
  return [
    defineTool({
      name: 'system_status',
      description: 'Get a system-level status overview (errors, auto-issues, queues, credits). Admin-only.',
      category: 'readonly',
      toolset: 'core',
      platforms: ['admin-ui', 'api', 'mcp'],
      inputSchema: z.object({
        since: z.string().optional().describe('Time window (e.g., "30m", "2h", "1d")'),
        avatarId: z.string().optional().describe('Optional avatar to include tool credits/energy'),
      }),
      execute: async (input, context): Promise<ToolResult> => {
        if (!context.session?.isAdmin) {
          return { success: false, error: 'Admin access required' };
        }
        const since = parseSinceInput(input.since);
        const result = await services.getSystemStatus({ since, avatarId: input.avatarId });
        return { success: true, data: result };
      },
    }),
    defineTool({
      name: 'my_activity',
      description: 'Get a recent activity timeline for an avatar, plus a summary.',
      category: 'readonly',
      toolset: 'core',
      platforms: ['admin-ui', 'api', 'mcp'],
      inputSchema: z.object({
        avatarId: z.string().describe('Avatar ID to inspect'),
        since: z.string().optional().describe('Time window (e.g., "30m", "2h", "1d")'),
        limit: z.number().min(1).max(500).optional().describe('Max items to return'),
      }),
      execute: async (input, context): Promise<ToolResult> => {
        if (!canAccessAvatar(context, input.avatarId)) {
          return { success: false, error: 'Access denied' };
        }
        const since = parseSinceInput(input.since);
        const activity = await services.getAvatarActivity(input.avatarId, {
          since,
          limit: input.limit,
        });

        const summaryText = [
          `Errors: ${activity.summary.errorCount}`,
          `Warnings: ${activity.summary.warnCount}`,
          `Issues: ${activity.summary.issueCount}`,
          `Feedback: ${activity.summary.feedbackCount}`,
          `Pending jobs: ${activity.summary.pendingJobs}`,
        ].join(' • ');

        return {
          success: true,
          data: {
            summary: activity.summary,
            summaryText,
            window: activity.window,
            items: activity.items,
          },
        };
      },
    }),
  ];
}

export default createObservabilityTools;
