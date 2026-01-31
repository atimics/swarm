/**
 * Job Status Tools
 * 
 * Tools for tracking async media generation jobs.
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

export interface JobInfo {
  jobId: string;
  type: 'image' | 'video' | 'sticker';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  prompt?: string;
  resultUrl?: string;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

export interface JobServices {
  getPendingJobs: (avatarId: string) => Promise<JobInfo[]>;
  getJob: (avatarId: string, jobId: string) => Promise<JobInfo | null>;
}

export interface CreditStatus {
  generate_image: { used: number; limit: number; remaining: number };
  generate_video: { used: number; limit: number; remaining: number };
  generate_sticker: { used: number; limit: number; remaining: number };
  [key: string]: { used: number; limit: number; remaining: number };
}

export interface EnergyStatus {
  current: number;
  max: number;
  nextRefillIn: number;
}

export interface CreditServices {
  getToolStatus: (avatarId: string) => Promise<CreditStatus | Record<string, unknown>>;
  getEnergyStatus?: (avatarId: string) => Promise<EnergyStatus>;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createJobTools = (
  jobServices: JobServices,
  creditServices: CreditServices
) => [
  defineTool({
    name: 'get_pending_jobs',
    description: 'Get all pending media generation jobs.',
    category: 'readonly',
    toolset: 'jobs',
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      const jobs = await jobServices.getPendingJobs(context.avatarId);

      return {
        success: true,
        data: jobs.map(job => ({
          jobId: job.jobId,
          type: job.type,
          status: job.status,
          prompt: job.prompt,
          createdAt: new Date(job.createdAt).toISOString(),
          resultUrl: job.resultUrl,
        })),
      };
    },
  }),

  defineTool({
    name: 'get_job_status',
    description: 'Get the status of a specific media generation job.',
    category: 'readonly',
    toolset: 'jobs',
    inputSchema: z.object({
      jobId: z.string().describe('The job ID to check'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      const job = await jobServices.getJob(context.avatarId, input.jobId);

      if (!job) {
        return { success: false, error: 'Job not found' };
      }

      const result: ToolResult = {
        success: true,
        data: {
          jobId: job.jobId,
          type: job.type,
          status: job.status,
          prompt: job.prompt,
          resultUrl: job.resultUrl,
          error: job.error,
          createdAt: new Date(job.createdAt).toISOString(),
          completedAt: job.completedAt ? new Date(job.completedAt).toISOString() : undefined,
        },
      };

      // If job completed with media, include it
      if (job.status === 'completed' && job.resultUrl) {
        result.media = {
          type: job.type === 'video' ? 'video' : 'image',
          url: job.resultUrl,
          caption: job.prompt,
        };
      }

      return result;
    },
  }),

  defineTool({
    name: 'get_tool_credits',
    description: 'Check my remaining credits for media generation tools.',
    category: 'readonly',
    toolset: 'jobs',
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      const status = await creditServices.getToolStatus(context.avatarId);

      return {
        success: true,
        data: {
          generate_image: status.generate_image,
          generate_video: status.generate_video,
          generate_sticker: status.generate_sticker,
        },
      };
    },
  }),

  defineTool({
    name: 'get_energy_status',
    description: 'Check my current energy level and regeneration rate. Energy is used for expensive operations like voice (1⚡), images (2⚡), and videos (3⚡). Base rate is 1 energy/hour, but your owner can boost this by holding $RATI tokens!',
    category: 'readonly',
    toolset: 'jobs',
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      if (!creditServices.getEnergyStatus) {
        return { success: false, error: 'Energy system not available' };
      }
      const status = await creditServices.getEnergyStatus(context.avatarId);

      // Build dynamic description based on refill rate
      const refillRate = (status as { refillPerHour?: number }).refillPerHour || 1;
      const bonusRate = (status as { bonusRefillPerHour?: number }).bonusRefillPerHour || 0;
      const tokenBalance = (status as { ownerTokenBalance?: number }).ownerTokenBalance;
      
      let rateInfo = `${refillRate}/hour`;
      if (bonusRate > 0) {
        rateInfo += ` (base: 1 + bonus: ${bonusRate} from owner's $RATI tokens)`;
      }

      return {
        success: true,
        data: {
          current: status.current,
          max: status.max,
          nextRefillIn: status.nextRefillIn > 0 ? `${status.nextRefillIn} minutes` : 'Full',
          refillRate: rateInfo,
          ownerTokenBalance: tokenBalance !== undefined ? `${(tokenBalance / 1_000_000).toFixed(2)}M $RATI` : undefined,
          costs: {
            voice: 1,
            image: 2,
            video: 3,
          },
          tip: bonusRate === 0 
            ? 'Your owner can boost your energy regeneration by holding $RATI tokens!' 
            : undefined,
        },
      };
    },
  }),
];

export default createJobTools;
