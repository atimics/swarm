/**
 * Runtime Entitlement Enforcement
 * 
 * Provides entitlement checking for runtime handlers (message-processor, response-sender, etc.)
 * This wraps the admin-api entitlements service for use in Lambda handlers.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@swarm/core';

// Use STATE_TABLE for usage tracking (handlers don't have ADMIN_TABLE)
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

// Default plan limits for free tier (stateless)
const FREE_TIER_LIMITS = {
  memoryEnabled: false,
  memoryRetentionDays: 0,
  maxMemoriesPerTier: 0,
  dailyMessageLimit: 50,
  dailyMediaCredits: 5,
  dailyVoiceMinutes: 2,
  maxToolCallsPerMessage: 3,
  maxPlatforms: 1,
  maxChannels: 2,
  autonomousPostsEnabled: false,
  customModelEnabled: false,
  priorityProcessing: false,
};

export interface RuntimeLimits {
  memoryEnabled: boolean;
  dailyMessageLimit: number;
  dailyMediaCredits: number;
  dailyVoiceMinutes: number;
  maxToolCallsPerMessage: number;
  autonomousPostsEnabled: boolean;
  priorityProcessing: boolean;
}

export interface EnforcementResult {
  allowed: boolean;
  reason?: string;
  limit?: number;
  current?: number;
}

/**
 * Get cached runtime limits for an avatar
 * Uses STATE_TABLE with GSI to lookup entitlements
 */
const limitsCache = new Map<string, { limits: RuntimeLimits; expiresAt: number }>();
const CACHE_TTL_MS = 60_000; // 1 minute cache

export async function getRuntimeLimits(avatarId: string): Promise<RuntimeLimits> {
  const stateTable = process.env.STATE_TABLE;
  if (!stateTable) {
    logger.warn('STATE_TABLE not set, using free tier limits');
    return FREE_TIER_LIMITS;
  }

  // Check cache
  const cached = limitsCache.get(avatarId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.limits;
  }

  try {
    // Try to find entitlement via GSI (AVATAR#{avatarId} / ENTITLEMENT)
    // Note: In shared handler context, we might need to query ADMIN_TABLE
    // For now, we'll store a copy in STATE_TABLE for fast runtime access
    const result = await dynamoClient.send(new GetCommand({
      TableName: stateTable,
      Key: {
        pk: `LIMITS#${avatarId}`,
        sk: 'RUNTIME',
      },
    }));

    if (result.Item) {
      const limits = result.Item as RuntimeLimits & { pk: string; sk: string };
      limitsCache.set(avatarId, { limits, expiresAt: Date.now() + CACHE_TTL_MS });
      return limits;
    }
  } catch (err) {
    logger.warn('Failed to fetch runtime limits, using free tier', {
      avatarId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Default to free tier
  limitsCache.set(avatarId, { limits: FREE_TIER_LIMITS, expiresAt: Date.now() + CACHE_TTL_MS });
  return FREE_TIER_LIMITS;
}

/**
 * Get today's date string
 */
function getTodayString(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Track and check message limit
 * Returns true if the message can be processed
 */
export async function checkAndIncrementMessageUsage(avatarId: string): Promise<EnforcementResult> {
  const stateTable = process.env.STATE_TABLE;
  if (!stateTable) {
    return { allowed: true }; // Allow if no table configured
  }

  const limits = await getRuntimeLimits(avatarId);
  
  // -1 means unlimited
  if (limits.dailyMessageLimit === -1) {
    await incrementUsageCounter(avatarId, 'messages');
    return { allowed: true };
  }

  const dateStr = getTodayString();
  const current = await getUsageCounter(avatarId, 'messages', dateStr);

  if (current >= limits.dailyMessageLimit) {
    logger.warn('Message limit reached', {
      avatarId,
      current,
      limit: limits.dailyMessageLimit,
    });
    return {
      allowed: false,
      reason: 'Daily message limit reached',
      limit: limits.dailyMessageLimit,
      current,
    };
  }

  await incrementUsageCounter(avatarId, 'messages');
  return { allowed: true, limit: limits.dailyMessageLimit, current: current + 1 };
}

/**
 * Check if media generation is allowed
 */
export async function checkMediaLimit(avatarId: string): Promise<EnforcementResult> {
  const stateTable = process.env.STATE_TABLE;
  if (!stateTable) {
    return { allowed: true };
  }

  const limits = await getRuntimeLimits(avatarId);
  
  if (limits.dailyMediaCredits === -1) {
    return { allowed: true };
  }

  const dateStr = getTodayString();
  const current = await getUsageCounter(avatarId, 'media', dateStr);

  if (current >= limits.dailyMediaCredits) {
    return {
      allowed: false,
      reason: 'Daily media generation limit reached',
      limit: limits.dailyMediaCredits,
      current,
    };
  }

  return { allowed: true, limit: limits.dailyMediaCredits, current };
}

/**
 * Increment media usage after successful generation
 */
export async function incrementMediaUsage(avatarId: string): Promise<void> {
  await incrementUsageCounter(avatarId, 'media');
}

/**
 * Check if memory writes are allowed for this avatar
 */
export async function isMemoryWriteAllowed(avatarId: string): Promise<boolean> {
  const limits = await getRuntimeLimits(avatarId);
  return limits.memoryEnabled;
}

/**
 * Check tool call limit for a message
 */
export async function checkToolCallLimit(
  avatarId: string,
  currentToolCalls: number
): Promise<EnforcementResult> {
  const limits = await getRuntimeLimits(avatarId);
  
  if (limits.maxToolCallsPerMessage === -1) {
    return { allowed: true };
  }

  if (currentToolCalls >= limits.maxToolCallsPerMessage) {
    return {
      allowed: false,
      reason: 'Maximum tool calls per message reached',
      limit: limits.maxToolCallsPerMessage,
      current: currentToolCalls,
    };
  }

  return { allowed: true, limit: limits.maxToolCallsPerMessage, current: currentToolCalls };
}

// ============================================================================
// Usage Counter Helpers
// ============================================================================

async function getUsageCounter(
  avatarId: string,
  counterType: 'messages' | 'media' | 'voice' | 'tools',
  date: string
): Promise<number> {
  const stateTable = process.env.STATE_TABLE;
  if (!stateTable) return 0;

  try {
    const result = await dynamoClient.send(new GetCommand({
      TableName: stateTable,
      Key: {
        pk: `USAGE#${avatarId}`,
        sk: `${counterType.toUpperCase()}#${date}`,
      },
    }));

    return (result.Item?.count as number) || 0;
  } catch {
    return 0;
  }
}

async function incrementUsageCounter(
  avatarId: string,
  counterType: 'messages' | 'media' | 'voice' | 'tools'
): Promise<void> {
  const stateTable = process.env.STATE_TABLE;
  if (!stateTable) return;

  const dateStr = getTodayString();
  // TTL: 35 days from today
  const ttl = Math.floor(Date.now() / 1000) + (35 * 24 * 60 * 60);

  try {
    await dynamoClient.send(new UpdateCommand({
      TableName: stateTable,
      Key: {
        pk: `USAGE#${avatarId}`,
        sk: `${counterType.toUpperCase()}#${dateStr}`,
      },
      UpdateExpression: `
        SET #count = if_not_exists(#count, :zero) + :one,
            avatarId = :avatarId,
            #date = :date,
            #ttl = :ttl,
            updatedAt = :now
      `,
      ExpressionAttributeNames: {
        '#count': 'count',
        '#date': 'date',
        '#ttl': 'ttl',
      },
      ExpressionAttributeValues: {
        ':zero': 0,
        ':one': 1,
        ':avatarId': avatarId,
        ':date': dateStr,
        ':ttl': ttl,
        ':now': Date.now(),
      },
    }));
  } catch (err) {
    logger.warn('Failed to increment usage counter', {
      avatarId,
      counterType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Sync runtime limits from admin API entitlements to state table
 * Called by admin API when entitlements change
 */
export async function syncRuntimeLimits(
  avatarId: string,
  limits: RuntimeLimits
): Promise<void> {
  const stateTable = process.env.STATE_TABLE;
  if (!stateTable) return;

  await dynamoClient.send(new UpdateCommand({
    TableName: stateTable,
    Key: {
      pk: `LIMITS#${avatarId}`,
      sk: 'RUNTIME',
    },
    UpdateExpression: `
      SET memoryEnabled = :memoryEnabled,
          dailyMessageLimit = :dailyMessageLimit,
          dailyMediaCredits = :dailyMediaCredits,
          dailyVoiceMinutes = :dailyVoiceMinutes,
          maxToolCallsPerMessage = :maxToolCallsPerMessage,
          autonomousPostsEnabled = :autonomousPostsEnabled,
          priorityProcessing = :priorityProcessing,
          updatedAt = :now
    `,
    ExpressionAttributeValues: {
      ':memoryEnabled': limits.memoryEnabled,
      ':dailyMessageLimit': limits.dailyMessageLimit,
      ':dailyMediaCredits': limits.dailyMediaCredits,
      ':dailyVoiceMinutes': limits.dailyVoiceMinutes,
      ':maxToolCallsPerMessage': limits.maxToolCallsPerMessage,
      ':autonomousPostsEnabled': limits.autonomousPostsEnabled,
      ':priorityProcessing': limits.priorityProcessing,
      ':now': Date.now(),
    },
  }));

  // Invalidate cache
  limitsCache.delete(avatarId);
}
