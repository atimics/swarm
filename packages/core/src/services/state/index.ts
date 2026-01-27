/**
 * State Service - DynamoDB-based state management
 * Multi-tenant storage for channel state, user cooldowns, and avatar state
 *
 * Supports Kyro-style channel-aware messaging:
 * - State machine: IDLE → ACTIVE → COOLDOWN
 * - Response triggers: direct engagement, message threshold, conversation gap
 * - Message buffering with context preservation
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  AvatarConfig,
  ChannelState,
  ChannelStateMachine,
  ContextMessage,
  MemoryFact,
  Platform,
  ResponseDecision,
  StateService,
  UserCooldown,
} from '../../types/index.js';
import {
  CHANNEL_CONFIG,
  addMessageToChannel,
  buildConversationContext,
  evaluateResponseTrigger,
  getActiveParticipants,
  getChannelState,
  getOrCreateChannelState,
  getResponseTarget,
  isActiveTimedOut,
  isCooldownExpired,
  markResponseSent,
  transitionState,
  updateChannelState,
  getAllChannelStates,
  getChannelStatesForPlatform,
  getActiveChannels,
} from './channel-state.js';
import {
  clearUserCooldown,
  getUserCooldown,
  setUserCooldown,
} from './user-cooldowns.js';
import {
  getLastAutonomousPostTime,
  setLastAutonomousPostTime,
} from './autonomous-timing.js';
import {
  getFacts,
  saveFact,
} from './fact-store.js';

export {
  CHANNEL_CONFIG,
  getAllChannelStates,
  getChannelStatesForPlatform,
  getActiveChannels,
} from './channel-state.js';

export class DynamoDBStateService implements StateService {
  private docClient: DynamoDBDocumentClient;
  private tableName: string;

  constructor(tableName: string, docClient?: DynamoDBDocumentClient) {
    if (docClient) {
      this.docClient = docClient;
    } else {
      const client = new DynamoDBClient({ region: 'us-east-1' });
      this.docClient = DynamoDBDocumentClient.from(client, {
        marshallOptions: {
          removeUndefinedValues: true,
        },
      });
    }
    this.tableName = tableName;
  }

  // =====================================================================
  // CHANNEL STATE
  // =====================================================================

  async getChannelState(avatarId: string, channelId: string): Promise<ChannelState | null> {
    return getChannelState(this.docClient, this.tableName, avatarId, channelId);
  }

  async updateChannelState(state: ChannelState): Promise<void> {
    return updateChannelState(this.docClient, this.tableName, state);
  }

  async getOrCreateChannelState(
    avatarId: string,
    channelId: string,
    platform: Platform,
    chatType?: 'private' | 'group' | 'supergroup' | 'channel',
    chatTitle?: string
  ): Promise<ChannelState> {
    return getOrCreateChannelState(
      this.docClient,
      this.tableName,
      avatarId,
      channelId,
      platform,
      chatType,
      chatTitle
    );
  }

  async addMessageToChannel(
    avatarId: string,
    channelId: string,
    platform: Platform,
    message: ContextMessage,
    maxMessages: number = CHANNEL_CONFIG.MAX_BUFFER_SIZE,
    chatType?: 'private' | 'group' | 'supergroup' | 'channel',
    chatTitle?: string
  ): Promise<ChannelState> {
    return addMessageToChannel(
      this.docClient,
      this.tableName,
      avatarId,
      channelId,
      platform,
      message,
      maxMessages,
      chatType,
      chatTitle
    );
  }

  // =====================================================================
  // KYRO-STYLE STATE MACHINE
  // =====================================================================

  async transitionState(
    avatarId: string,
    channelId: string,
    newState: ChannelStateMachine
  ): Promise<ChannelState | null> {
    return transitionState(this.docClient, this.tableName, avatarId, channelId, newState);
  }

  async markResponseSent(
    avatarId: string,
    channelId: string,
    responseMessageId: string
  ): Promise<ChannelState | null> {
    return markResponseSent(this.docClient, this.tableName, avatarId, channelId, responseMessageId);
  }

  isCooldownExpired(state: ChannelState): boolean {
    return isCooldownExpired(state);
  }

  isActiveTimedOut(state: ChannelState): boolean {
    return isActiveTimedOut(state);
  }

  evaluateResponseTrigger(state: ChannelState): ResponseDecision {
    return evaluateResponseTrigger(state);
  }

  getResponseTarget(state: ChannelState): ContextMessage | null {
    return getResponseTarget(state);
  }

  buildConversationContext(state: ChannelState, maxTokens: number = 4000): string {
    return buildConversationContext(state, maxTokens);
  }

  getActiveParticipants(state: ChannelState): Array<{
    id: string;
    name: string;
    username?: string;
    messageCount: number;
  }> {
    return getActiveParticipants(state);
  }

  // =====================================================================
  // USER COOLDOWNS
  // =====================================================================

  async getUserCooldown(
    avatarId: string,
    platform: Platform,
    userId: string
  ): Promise<UserCooldown | null> {
    return getUserCooldown(this.docClient, this.tableName, avatarId, platform, userId);
  }

  async setUserCooldown(cooldown: UserCooldown): Promise<void> {
    return setUserCooldown(this.docClient, this.tableName, cooldown);
  }

  async clearUserCooldown(
    avatarId: string,
    platform: Platform,
    userId: string
  ): Promise<void> {
    return clearUserCooldown(this.docClient, this.tableName, avatarId, platform, userId);
  }

  // =====================================================================
  // AGENT CONFIG
  // =====================================================================

  async getAvatarConfig(avatarId: string): Promise<AvatarConfig | null> {
    const result = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: 'CONFIG',
      },
    }));

    if (!result.Item) {
      return null;
    }

    return result.Item.config as AvatarConfig;
  }

  async saveAvatarConfig(config: AvatarConfig): Promise<void> {
    await this.docClient.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        pk: `AVATAR#${config.id}`,
        sk: 'CONFIG',
        config,
        updatedAt: Date.now(),
      },
    }));
  }

  async listAvatars(): Promise<string[]> {
    // Note: Using Scan because begins_with() cannot be used on partition keys in Query.
    // For better performance at scale, consider adding a GSI with entityType as PK.
    const avatarIds: string[] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
      const result = await this.docClient.send(new ScanCommand({
        TableName: this.tableName,
        FilterExpression: 'begins_with(pk, :prefix) AND sk = :sk',
        ExpressionAttributeValues: {
          ':prefix': 'AVATAR#',
          ':sk': 'CONFIG',
        },
        ProjectionExpression: 'pk',
        ExclusiveStartKey: lastEvaluatedKey as never,
      }));

      for (const item of result.Items || []) {
        const pk = item.pk as string | undefined;
        if (!pk?.startsWith('AVATAR#')) continue;
        avatarIds.push(pk.replace('AVATAR#', ''));
      }

      lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastEvaluatedKey);

    return avatarIds;
  }

  // =====================================================================
  // IDEMPOTENCY
  // =====================================================================

  async checkAndSetIdempotency(key: string, ttlSeconds: number = 3600): Promise<boolean> {
    const ttl = Math.floor(Date.now() / 1000) + ttlSeconds;

    try {
      await this.docClient.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: 'IDEMPOTENCY',
          sk: key,
          createdAt: Date.now(),
          ttl,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }));

      return true; // Key was set, this is the first processing
    } catch (error: unknown) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
        return false; // Key exists, already processed
      }
      throw error;
    }
  }

  // =====================================================================
  // SCHEDULED TASKS STATE
  // =====================================================================

  async getLastMentionId(avatarId: string): Promise<string | null> {
    const result = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: 'TWITTER#LAST_MENTION',
      },
    }));

    return result.Item?.lastMentionId || null;
  }

  async setLastMentionId(avatarId: string, mentionId: string): Promise<void> {
    await this.docClient.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        pk: `AVATAR#${avatarId}`,
        sk: 'TWITTER#LAST_MENTION',
        lastMentionId: mentionId,
        updatedAt: Date.now(),
      },
    }));
  }

  // =====================================================================
  // AUTONOMOUS POST TIMING
  // =====================================================================

  async getLastAutonomousPostTime(avatarId: string): Promise<number> {
    return getLastAutonomousPostTime(this.docClient, this.tableName, avatarId);
  }

  async setLastAutonomousPostTime(avatarId: string, timestamp: number): Promise<void> {
    return setLastAutonomousPostTime(this.docClient, this.tableName, avatarId, timestamp);
  }

  // =====================================================================
  // MEMORY / FACTS STORAGE
  // =====================================================================

  async saveFact(avatarId: string, fact: MemoryFact): Promise<void> {
    return saveFact(this.docClient, this.tableName, avatarId, fact);
  }

  async getFacts(avatarId: string, query: string, userId?: string): Promise<MemoryFact[]> {
    return getFacts(this.docClient, this.tableName, avatarId, query, userId);
  }

  // =====================================================================
  // CROSS-PLATFORM QUERIES
  // =====================================================================

  async getAllChannelStates(avatarId: string, limit?: number): Promise<ChannelState[]> {
    return getAllChannelStates(this.docClient, this.tableName, avatarId, limit);
  }

  async getChannelStatesForPlatform(
    avatarId: string,
    platform: Platform,
    limit?: number
  ): Promise<ChannelState[]> {
    return getChannelStatesForPlatform(this.docClient, this.tableName, avatarId, platform, limit);
  }

  async getActiveChannels(avatarId: string, maxAgeMs?: number): Promise<ChannelState[]> {
    return getActiveChannels(this.docClient, this.tableName, avatarId, maxAgeMs);
  }
}

/**
 * Factory function
 */
export function createStateService(tableName: string, region?: string): DynamoDBStateService {
  if (region) {
    const client = new DynamoDBClient({ region });
    const docClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
    return new DynamoDBStateService(tableName, docClient);
  }
  return new DynamoDBStateService(tableName);
}
