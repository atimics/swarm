/**
 * Content Store Service
 *
 * DynamoDB-based storage for Twitter posts (generated, ingested, simulation).
 * Enables decoupled post generation, review workflows, and simulation mode.
 *
 * Schema:
 * PK: AVATAR#<avatarId>
 * SK: POST#<timestamp>#<postId>
 *
 * GSI1PK: AVATAR#<avatarId>#POSTSTATUS#<status>
 * GSI1SK: <timestamp>#<postId>
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import type {
  ContentStorePost,
  CreatePostParams,
  PostStatus,
  ModerationConfig,
} from '../types/content-store.js';
import {
  DEFAULT_MODERATION_CONFIG,
} from '../types/content-store.js';

// TTL durations
const POSTED_TTL_DAYS = 90;
const REJECTED_TTL_DAYS = 7;
const PENDING_TTL_DAYS = 30;

/**
 * Content Store Service Interface
 */
export interface ContentStoreService {
  // CRUD operations
  createPost(params: CreatePostParams): Promise<ContentStorePost>;
  getPost(avatarId: string, postId: string): Promise<ContentStorePost | null>;
  listPostsByStatus(avatarId: string, status: PostStatus, limit?: number): Promise<ContentStorePost[]>;
  listRecentPosts(avatarId: string, limit?: number): Promise<ContentStorePost[]>;

  // Lifecycle transitions
  markQueued(avatarId: string, postId: string): Promise<ContentStorePost | null>;
  markPosted(avatarId: string, postId: string, twitterId: string): Promise<ContentStorePost | null>;
  markFailed(avatarId: string, postId: string, error: string): Promise<ContentStorePost | null>;
  markRateLimited(avatarId: string, postId: string, retryAfter: number): Promise<ContentStorePost | null>;

  // Review operations
  approve(avatarId: string, postId: string, reviewerId: string): Promise<ContentStorePost | null>;
  reject(avatarId: string, postId: string, reviewerId: string, reason: string): Promise<ContentStorePost | null>;
  updateQualityScore(avatarId: string, postId: string, delta: number): Promise<ContentStorePost | null>;

  // Feeds
  getSimulatedFeed(avatarId: string, limit?: number): Promise<ContentStorePost[]>;
  getMixedFeed(avatarId: string, limit?: number): Promise<ContentStorePost[]>;
  getPendingReviewPosts(avatarId: string, limit?: number): Promise<ContentStorePost[]>;

  // Moderation config
  getModerationConfig(avatarId: string): Promise<ModerationConfig>;
  setModerationConfig(avatarId: string, config: Partial<ModerationConfig>): Promise<ModerationConfig>;
  incrementApprovedPostCount(avatarId: string): Promise<ModerationConfig>;
}

/**
 * DynamoDB implementation of ContentStoreService
 */
export class DynamoDBContentStoreService implements ContentStoreService {
  private docClient: DynamoDBDocumentClient;
  private tableName: string;

  private static readonly POST_ID_SK_PREFIX = 'POSTID#';

  constructor(tableName: string, docClient?: DynamoDBDocumentClient) {
    if (docClient) {
      this.docClient = docClient;
    } else {
      const client = new DynamoDBClient({});
      this.docClient = DynamoDBDocumentClient.from(client, {
        marshallOptions: { removeUndefinedValues: true },
      });
    }
    this.tableName = tableName;
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  private buildPK(avatarId: string): string {
    return `AVATAR#${avatarId}`;
  }

  private buildSK(timestamp: number, postId: string): string {
    return `POST#${timestamp}#${postId}`;
  }

  private buildPostIdSK(postId: string): string {
    return `${DynamoDBContentStoreService.POST_ID_SK_PREFIX}${postId}`;
  }

  private buildGSI1PK(avatarId: string, status: PostStatus): string {
    return `AVATAR#${avatarId}#POSTSTATUS#${status}`;
  }

  private buildGSI1SK(timestamp: number, postId: string): string {
    return `${timestamp}#${postId}`;
  }

  private getTTL(status: PostStatus): number | undefined {
    const now = Math.floor(Date.now() / 1000);
    switch (status) {
      case 'posted':
        return now + (POSTED_TTL_DAYS * 24 * 60 * 60);
      case 'rejected':
        return now + (REJECTED_TTL_DAYS * 24 * 60 * 60);
      case 'pending_review':
      case 'approved':
      case 'queued':
        return now + (PENDING_TTL_DAYS * 24 * 60 * 60);
      case 'failed':
        return now + (PENDING_TTL_DAYS * 24 * 60 * 60);
      default:
        return undefined;
    }
  }

  private itemToPost(item: Record<string, unknown>): ContentStorePost {
    return {
      postId: item.postId as string,
      avatarId: item.avatarId as string,
      text: item.text as string,
      media: item.media as ContentStorePost['media'],
      source: item.source as ContentStorePost['source'],
      status: item.status as PostStatus,
      qualityScore: item.qualityScore as number,
      twitterId: item.twitterId as string | undefined,
      postAttempts: item.postAttempts as number,
      lastError: item.lastError as string | undefined,
      rateLimitedUntil: item.rateLimitedUntil as number | undefined,
      communityId: item.communityId as string | undefined,
      communityName: item.communityName as string | undefined,
      inReplyToId: item.inReplyToId as string | undefined,
      scheduledAt: item.scheduledAt as number | undefined,
      reviewerId: item.reviewerId as string | undefined,
      reviewReason: item.reviewReason as string | undefined,
      createdAt: item.createdAt as number,
      updatedAt: item.updatedAt as number,
      ttl: item.ttl as number | undefined,
    };
  }

  // =========================================================================
  // CRUD OPERATIONS
  // =========================================================================

  async createPost(params: CreatePostParams): Promise<ContentStorePost> {
    const now = Date.now();
    const postId = randomUUID();
    const status = params.status || 'pending_review';
    const qualityScore = params.qualityScore ?? 100;

    const post: ContentStorePost = {
      postId,
      avatarId: params.avatarId,
      text: params.text,
      media: params.media,
      source: params.source,
      status,
      qualityScore,
      postAttempts: 0,
      communityId: params.communityId,
      communityName: params.communityName,
      inReplyToId: params.inReplyToId,
      scheduledAt: params.scheduledAt,
      createdAt: now,
      updatedAt: now,
      ttl: this.getTTL(status),
    };

    const pk = this.buildPK(params.avatarId);
    const postSk = this.buildSK(now, postId);
    const ttl = this.getTTL(status);

    await this.docClient.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: this.tableName,
            Item: {
              pk,
              sk: postSk,
              gsi1pk: this.buildGSI1PK(params.avatarId, status),
              gsi1sk: this.buildGSI1SK(now, postId),
              ...post,
              ttl,
            },
          },
        },
        {
          Put: {
            TableName: this.tableName,
            Item: {
              pk,
              sk: this.buildPostIdSK(postId),
              postId,
              postSk,
              createdAt: now,
              ttl,
            },
          },
        },
      ],
    }));

    return post;
  }

  async getPost(avatarId: string, postId: string): Promise<ContentStorePost | null> {
    const pk = this.buildPK(avatarId);

    // Fast path: look up the post's real SK via a pointer item.
    const pointerResult = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        pk,
        sk: this.buildPostIdSK(postId),
      },
    }));

    const postSk = (pointerResult.Item as { postSk?: string } | undefined)?.postSk;
    if (postSk) {
      const postResult = await this.docClient.send(new GetCommand({
        TableName: this.tableName,
        Key: { pk, sk: postSk },
      }));

      if (!postResult.Item) return null;
      return this.itemToPost(postResult.Item as Record<string, unknown>);
    }

    // Backward-compatible fallback for legacy posts created before pointer items existed.
    // NOTE: Do NOT use Limit with FilterExpression - Limit applies before filter.
    const result = await this.docClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      FilterExpression: 'postId = :postId',
      ExpressionAttributeValues: {
        ':pk': pk,
        ':skPrefix': 'POST#',
        ':postId': postId,
      },
    }));

    if (!result.Items || result.Items.length === 0) return null;
    return this.itemToPost(result.Items[0] as Record<string, unknown>);
  }

  async listPostsByStatus(avatarId: string, status: PostStatus, limit: number = 50): Promise<ContentStorePost[]> {
    const result = await this.docClient.send(new QueryCommand({
      TableName: this.tableName,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :gsi1pk',
      ExpressionAttributeValues: {
        ':gsi1pk': this.buildGSI1PK(avatarId, status),
      },
      Limit: limit,
      ScanIndexForward: false, // Most recent first
    }));

    return (result.Items || []).map(item => this.itemToPost(item as Record<string, unknown>));
  }

  async listRecentPosts(avatarId: string, limit: number = 50): Promise<ContentStorePost[]> {
    const result = await this.docClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': this.buildPK(avatarId),
        ':skPrefix': 'POST#',
      },
      Limit: limit,
      ScanIndexForward: false, // Most recent first
    }));

    return (result.Items || []).map(item => this.itemToPost(item as Record<string, unknown>));
  }

  // =========================================================================
  // LIFECYCLE TRANSITIONS
  // =========================================================================

  private async updatePostStatus(
    avatarId: string,
    postId: string,
    newStatus: PostStatus,
    additionalUpdates?: Record<string, unknown>
  ): Promise<ContentStorePost | null> {
    const post = await this.getPost(avatarId, postId);
    if (!post) return null;

    const now = Date.now();
    const updates: Record<string, unknown> = {
      status: newStatus,
      updatedAt: now,
      gsi1pk: this.buildGSI1PK(avatarId, newStatus),
      gsi1sk: this.buildGSI1SK(post.createdAt, postId),
      ttl: this.getTTL(newStatus),
      ...additionalUpdates,
    };

    // Build update expression
    const updateParts: string[] = [];
    const exprAttrValues: Record<string, unknown> = {};
    const exprAttrNames: Record<string, string> = {};
    let idx = 0;

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        const attrName = `#attr${idx}`;
        const attrValue = `:val${idx}`;
        exprAttrNames[attrName] = key;
        exprAttrValues[attrValue] = value;
        updateParts.push(`${attrName} = ${attrValue}`);
        idx++;
      }
    }

    await this.docClient.send(new UpdateCommand({
      TableName: this.tableName,
      Key: {
        pk: this.buildPK(avatarId),
        sk: this.buildSK(post.createdAt, postId),
      },
      UpdateExpression: `SET ${updateParts.join(', ')}`,
      ExpressionAttributeNames: exprAttrNames,
      ExpressionAttributeValues: exprAttrValues,
    }));

    return {
      ...post,
      status: newStatus,
      updatedAt: now,
      ...additionalUpdates,
    } as ContentStorePost;
  }

  async markQueued(avatarId: string, postId: string): Promise<ContentStorePost | null> {
    return this.updatePostStatus(avatarId, postId, 'queued');
  }

  async markPosted(avatarId: string, postId: string, twitterId: string): Promise<ContentStorePost | null> {
    return this.updatePostStatus(avatarId, postId, 'posted', {
      twitterId,
      postAttempts: 1, // Will be incremented if retried
    });
  }

  async markFailed(avatarId: string, postId: string, error: string): Promise<ContentStorePost | null> {
    const post = await this.getPost(avatarId, postId);
    if (!post) return null;

    return this.updatePostStatus(avatarId, postId, 'failed', {
      lastError: error,
      postAttempts: post.postAttempts + 1,
    });
  }

  async markRateLimited(avatarId: string, postId: string, retryAfter: number): Promise<ContentStorePost | null> {
    const post = await this.getPost(avatarId, postId);
    if (!post) return null;

    const rateLimitedUntil = Date.now() + retryAfter;

    return this.updatePostStatus(avatarId, postId, 'queued', {
      rateLimitedUntil,
      postAttempts: post.postAttempts + 1,
    });
  }

  // =========================================================================
  // REVIEW OPERATIONS
  // =========================================================================

  async approve(avatarId: string, postId: string, reviewerId: string): Promise<ContentStorePost | null> {
    return this.updatePostStatus(avatarId, postId, 'approved', {
      reviewerId,
    });
  }

  async reject(avatarId: string, postId: string, reviewerId: string, reason: string): Promise<ContentStorePost | null> {
    return this.updatePostStatus(avatarId, postId, 'rejected', {
      reviewerId,
      reviewReason: reason,
    });
  }

  async updateQualityScore(avatarId: string, postId: string, delta: number): Promise<ContentStorePost | null> {
    const post = await this.getPost(avatarId, postId);
    if (!post) return null;

    const newScore = Math.max(0, Math.min(100, post.qualityScore + delta));

    await this.docClient.send(new UpdateCommand({
      TableName: this.tableName,
      Key: {
        pk: this.buildPK(avatarId),
        sk: this.buildSK(post.createdAt, postId),
      },
      UpdateExpression: 'SET qualityScore = :score, updatedAt = :now',
      ExpressionAttributeValues: {
        ':score': newScore,
        ':now': Date.now(),
      },
    }));

    return { ...post, qualityScore: newScore };
  }

  // =========================================================================
  // FEEDS
  // =========================================================================

  async getSimulatedFeed(avatarId: string, limit: number = 50): Promise<ContentStorePost[]> {
    // Get posts with source='simulation' that are approved or posted
    const result = await this.docClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      FilterExpression: '#source = :simulation AND (#status = :approved OR #status = :posted) AND qualityScore >= :minScore',
      ExpressionAttributeNames: {
        '#source': 'source',
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':pk': this.buildPK(avatarId),
        ':skPrefix': 'POST#',
        ':simulation': 'simulation',
        ':approved': 'approved',
        ':posted': 'posted',
        ':minScore': 50, // Exclude low-quality posts
      },
      Limit: limit,
      ScanIndexForward: false,
    }));

    return (result.Items || []).map(item => this.itemToPost(item as Record<string, unknown>));
  }

  async getMixedFeed(avatarId: string, limit: number = 50): Promise<ContentStorePost[]> {
    // Get all approved/posted posts regardless of source
    const result = await this.docClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      FilterExpression: '(#status = :approved OR #status = :posted) AND qualityScore >= :minScore',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':pk': this.buildPK(avatarId),
        ':skPrefix': 'POST#',
        ':approved': 'approved',
        ':posted': 'posted',
        ':minScore': 50,
      },
      Limit: limit,
      ScanIndexForward: false,
    }));

    return (result.Items || []).map(item => this.itemToPost(item as Record<string, unknown>));
  }

  async getPendingReviewPosts(avatarId: string, limit: number = 50): Promise<ContentStorePost[]> {
    return this.listPostsByStatus(avatarId, 'pending_review', limit);
  }

  // =========================================================================
  // MODERATION CONFIG
  // =========================================================================

  async getModerationConfig(avatarId: string): Promise<ModerationConfig> {
    const result = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        pk: this.buildPK(avatarId),
        sk: 'MODERATION_CONFIG',
      },
    }));

    if (!result.Item) {
      return { ...DEFAULT_MODERATION_CONFIG };
    }

    return {
      mode: result.Item.mode as ModerationConfig['mode'],
      autoGraduateAfter: result.Item.autoGraduateAfter as number,
      requireApprovalFor: result.Item.requireApprovalFor as ModerationConfig['requireApprovalFor'],
      approvedPostCount: result.Item.approvedPostCount as number,
      hasGraduated: result.Item.hasGraduated as boolean,
    };
  }

  async setModerationConfig(avatarId: string, config: Partial<ModerationConfig>): Promise<ModerationConfig> {
    const current = await this.getModerationConfig(avatarId);
    const updated = { ...current, ...config };

    await this.docClient.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        pk: this.buildPK(avatarId),
        sk: 'MODERATION_CONFIG',
        ...updated,
        updatedAt: Date.now(),
      },
    }));

    return updated;
  }

  async incrementApprovedPostCount(avatarId: string): Promise<ModerationConfig> {
    const current = await this.getModerationConfig(avatarId);
    const newCount = current.approvedPostCount + 1;
    const hasGraduated = newCount >= current.autoGraduateAfter;

    // If graduating, switch to 'post' moderation mode
    const updates: Partial<ModerationConfig> = {
      approvedPostCount: newCount,
      hasGraduated,
    };

    if (hasGraduated && !current.hasGraduated) {
      updates.mode = 'post';
    }

    return this.setModerationConfig(avatarId, updates);
  }
}

/**
 * Factory function
 */
export function createContentStoreService(tableName: string): ContentStoreService {
  return new DynamoDBContentStoreService(tableName);
}
