/**
 * Content Store Types
 *
 * Types for the Twitter simulation layer content store, which enables:
 * - Decoupled post generation from delivery
 * - Shadow feeds for bots without Twitter integration
 * - Post review/moderation before publishing
 * - Rate limiting with 429 detection and backoff
 */
import { z } from 'zod';

// =============================================================================
// CONTENT STORE POST TYPES
// =============================================================================

/**
 * Source of the post content
 */
export type PostSource = 'ingested' | 'generated' | 'simulation';

/**
 * Status of a post in the content store
 */
export type PostStatus = 'pending_review' | 'approved' | 'rejected' | 'queued' | 'posted' | 'failed';

/**
 * Media attachment for a post
 */
export interface PostMedia {
  type: 'image' | 'video' | 'gif';
  url: string;
  s3Key?: string;
  mimeType?: string;
}

/**
 * A post stored in the content store
 *
 * DynamoDB Schema:
 * PK: AVATAR#<avatarId>
 * SK: POST#<timestamp>#<postId>
 *
 * GSI1PK: AVATAR#<avatarId>#POSTSTATUS#<status>
 * GSI1SK: <timestamp>#<postId>
 */
export interface ContentStorePost {
  /** Unique post identifier */
  postId: string;
  /** Avatar that owns this post */
  avatarId: string;
  /** Post text content */
  text: string;
  /** Optional media attachments */
  media?: PostMedia[];
  /** Source of the post */
  source: PostSource;
  /** Current status */
  status: PostStatus;
  /** Quality score (0-100) for ranking/filtering */
  qualityScore: number;
  /** Twitter ID after successful posting */
  twitterId?: string;
  /** Number of post attempts */
  postAttempts: number;
  /** Last error message if failed */
  lastError?: string;
  /** Rate limited until this timestamp */
  rateLimitedUntil?: number;
  /** Target community ID for community posts */
  communityId?: string;
  /** Community name for display */
  communityName?: string;
  /** Whether this is a reply to another tweet */
  inReplyToId?: string;
  /** Scheduled post time (optional) */
  scheduledAt?: number;
  /** Reviewer ID who approved/rejected */
  reviewerId?: string;
  /** Review reason (for rejections) */
  reviewReason?: string;
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
  /** TTL for DynamoDB (seconds since epoch) */
  ttl?: number;
}

/**
 * Parameters for creating a new post
 */
export interface CreatePostParams {
  avatarId: string;
  text: string;
  media?: PostMedia[];
  source: PostSource;
  communityId?: string;
  communityName?: string;
  inReplyToId?: string;
  scheduledAt?: number;
  /** Initial status - defaults to 'pending_review' */
  status?: PostStatus;
  /** Initial quality score - defaults to 100 */
  qualityScore?: number;
}

// =============================================================================
// RATE LIMIT TYPES
// =============================================================================

/**
 * Twitter API tier
 */
export type TwitterApiTier = 'free' | 'basic';

/**
 * Rate limit state for Twitter posting
 *
 * DynamoDB Schema:
 * PK: RATELIMIT#twitter
 * SK: GLOBAL (or AVATAR#<avatarId>)
 */
export interface RateLimitState {
  /** Whether currently rate limited */
  isRateLimited: boolean;
  /** Rate limited until this timestamp */
  rateLimitedUntil?: number;
  /** Twitter API tier */
  tier: TwitterApiTier;
  /** Posts made this month */
  postsThisMonth: number;
  /** Posts made today */
  postsToday: number;
  /** Consecutive 429 errors received */
  consecutive429s: number;
  /** Timestamp of last 429 error */
  last429At?: number;
  /** Backoff until this timestamp (circuit breaker) */
  backoffUntil?: number;
  /** Month for postsThisMonth counter (YYYY-MM format) */
  currentMonth: string;
  /** Date for postsToday counter (YYYY-MM-DD format) */
  currentDay: string;
  /** Last successful post timestamp */
  lastSuccessAt?: number;
  /** Last update timestamp */
  updatedAt: number;
}

/**
 * Backoff schedule for consecutive 429s
 */
export const BACKOFF_SCHEDULE_MS: Record<number, number> = {
  1: 60_000,      // 1 minute
  2: 300_000,     // 5 minutes
  3: 900_000,     // 15 minutes
  4: 3_600_000,   // 1 hour (circuit breaker)
};

/**
 * Get backoff duration for a given consecutive 429 count
 */
export function getBackoffDuration(consecutive429s: number): number {
  if (consecutive429s <= 0) return 0;
  if (consecutive429s >= 4) return BACKOFF_SCHEDULE_MS[4];
  return BACKOFF_SCHEDULE_MS[consecutive429s] || BACKOFF_SCHEDULE_MS[4];
}

// =============================================================================
// MODERATION TYPES
// =============================================================================

/**
 * Moderation mode for posts
 */
export type ModerationMode = 'pre' | 'post' | 'none';

/**
 * Content types that can require moderation
 */
export type ModeratedContentType = 'tweets' | 'replies' | 'media';

/**
 * Moderation configuration for an avatar
 */
export interface ModerationConfig {
  /** Current moderation mode */
  mode: ModerationMode;
  /** Number of approved posts before graduation to configurable mode */
  autoGraduateAfter: number;
  /** Content types that require approval */
  requireApprovalFor: ModeratedContentType[];
  /** Total posts approved for this avatar */
  approvedPostCount: number;
  /** Whether the avatar has graduated from mandatory pre-moderation */
  hasGraduated: boolean;
}

/**
 * Default moderation config for new avatars
 */
export const DEFAULT_MODERATION_CONFIG: ModerationConfig = {
  mode: 'pre',
  autoGraduateAfter: 10,
  requireApprovalFor: ['tweets', 'replies', 'media'],
  approvedPostCount: 0,
  hasGraduated: false,
};

// =============================================================================
// SIMULATION TYPES
// =============================================================================

/**
 * Simulation configuration for an avatar's Twitter integration
 */
export interface TwitterSimulationConfig {
  /** Whether simulation mode is enabled */
  enabled: boolean;
  /** Feed visibility: 'self' = only see own posts, 'linked' = also see real Twitter */
  feedVisibility: 'self' | 'linked';
  /** Whether to auto-approve posts (skip pre-moderation in simulation) */
  autoApprove: boolean;
}

/**
 * Default simulation config
 */
export const DEFAULT_SIMULATION_CONFIG: TwitterSimulationConfig = {
  enabled: false,
  feedVisibility: 'self',
  autoApprove: false,
};

// =============================================================================
// POST QUEUE TYPES
// =============================================================================

/**
 * Message for the POST_QUEUE (SQS FIFO)
 */
export interface PostQueueMessage {
  /** Post ID to process */
  postId: string;
  /** Avatar ID */
  avatarId: string;
  /** Scheduled send time (optional) */
  scheduledAt?: number;
  /** Number of previous attempts */
  attempts: number;
  /** Original enqueue time */
  enqueuedAt: number;
}

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

export const PostSourceSchema = z.enum(['ingested', 'generated', 'simulation']);
export const PostStatusSchema = z.enum(['pending_review', 'approved', 'rejected', 'queued', 'posted', 'failed']);

export const PostMediaSchema = z.object({
  type: z.enum(['image', 'video', 'gif']),
  url: z.string(),
  s3Key: z.string().optional(),
  mimeType: z.string().optional(),
});

export const ContentStorePostSchema = z.object({
  postId: z.string(),
  avatarId: z.string(),
  text: z.string(),
  media: z.array(PostMediaSchema).optional(),
  source: PostSourceSchema,
  status: PostStatusSchema,
  qualityScore: z.number().min(0).max(100),
  twitterId: z.string().optional(),
  postAttempts: z.number(),
  lastError: z.string().optional(),
  rateLimitedUntil: z.number().optional(),
  communityId: z.string().optional(),
  communityName: z.string().optional(),
  inReplyToId: z.string().optional(),
  scheduledAt: z.number().optional(),
  reviewerId: z.string().optional(),
  reviewReason: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  ttl: z.number().optional(),
});

export const CreatePostParamsSchema = z.object({
  avatarId: z.string(),
  text: z.string(),
  media: z.array(PostMediaSchema).optional(),
  source: PostSourceSchema,
  communityId: z.string().optional(),
  communityName: z.string().optional(),
  inReplyToId: z.string().optional(),
  scheduledAt: z.number().optional(),
  status: PostStatusSchema.optional(),
  qualityScore: z.number().min(0).max(100).optional(),
});

export const TwitterApiTierSchema = z.enum(['free', 'basic']);

export const RateLimitStateSchema = z.object({
  isRateLimited: z.boolean(),
  rateLimitedUntil: z.number().optional(),
  tier: TwitterApiTierSchema,
  postsThisMonth: z.number(),
  postsToday: z.number(),
  consecutive429s: z.number(),
  last429At: z.number().optional(),
  backoffUntil: z.number().optional(),
  currentMonth: z.string(),
  currentDay: z.string(),
  lastSuccessAt: z.number().optional(),
  updatedAt: z.number(),
});

export const ModerationModeSchema = z.enum(['pre', 'post', 'none']);
export const ModeratedContentTypeSchema = z.enum(['tweets', 'replies', 'media']);

export const ModerationConfigSchema = z.object({
  mode: ModerationModeSchema,
  autoGraduateAfter: z.number(),
  requireApprovalFor: z.array(ModeratedContentTypeSchema),
  approvedPostCount: z.number(),
  hasGraduated: z.boolean(),
});

export const TwitterSimulationConfigSchema = z.object({
  enabled: z.boolean(),
  feedVisibility: z.enum(['self', 'linked']),
  autoApprove: z.boolean(),
});

export const PostQueueMessageSchema = z.object({
  postId: z.string(),
  avatarId: z.string(),
  scheduledAt: z.number().optional(),
  attempts: z.number(),
  enqueuedAt: z.number(),
});
