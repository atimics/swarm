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
  plan: 'free',
  source: 'default',
  entitlementStatus: 'none',
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

export interface RuntimeBurnAugmentation {
  totalBurned?: number;
  tier?: number;
  tierName?: string;
  maxEnergy?: number;
  regenPerHour?: number;
  updatedAt?: number;
}

export interface RuntimeEnergyAugmentation {
  current?: number;
  max?: number;
  refillPerHour?: number;
  nextRefillIn?: number;
  bankCredits?: number;
  updatedAt?: number;
}

export interface RuntimeAugmentations {
  burn?: RuntimeBurnAugmentation;
  energy?: RuntimeEnergyAugmentation;
}

export interface RuntimeContract extends RuntimeLimits {
  plan?: string;
  source?: string;
  entitlementStatus?: string;
  augmentations?: RuntimeAugmentations;
  updatedAt?: number;
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
const limitsCache = new Map<string, { contract: RuntimeContract; expiresAt: number }>();
const CACHE_TTL_MS = 60_000; // 1 minute cache

function toRuntimeContract(item: Record<string, unknown>): RuntimeContract {
  return {
    memoryEnabled: typeof item.memoryEnabled === 'boolean'
      ? item.memoryEnabled
      : FREE_TIER_LIMITS.memoryEnabled,
    dailyMessageLimit: typeof item.dailyMessageLimit === 'number'
      ? item.dailyMessageLimit
      : FREE_TIER_LIMITS.dailyMessageLimit,
    dailyMediaCredits: typeof item.dailyMediaCredits === 'number'
      ? item.dailyMediaCredits
      : FREE_TIER_LIMITS.dailyMediaCredits,
    dailyVoiceMinutes: typeof item.dailyVoiceMinutes === 'number'
      ? item.dailyVoiceMinutes
      : FREE_TIER_LIMITS.dailyVoiceMinutes,
    maxToolCallsPerMessage: typeof item.maxToolCallsPerMessage === 'number'
      ? item.maxToolCallsPerMessage
      : FREE_TIER_LIMITS.maxToolCallsPerMessage,
    autonomousPostsEnabled: typeof item.autonomousPostsEnabled === 'boolean'
      ? item.autonomousPostsEnabled
      : FREE_TIER_LIMITS.autonomousPostsEnabled,
    priorityProcessing: typeof item.priorityProcessing === 'boolean'
      ? item.priorityProcessing
      : FREE_TIER_LIMITS.priorityProcessing,
    plan: typeof item.plan === 'string' ? item.plan : FREE_TIER_LIMITS.plan,
    source: typeof item.source === 'string' ? item.source : FREE_TIER_LIMITS.source,
    entitlementStatus: typeof item.entitlementStatus === 'string'
      ? item.entitlementStatus
      : FREE_TIER_LIMITS.entitlementStatus,
    augmentations: typeof item.augmentations === 'object' && item.augmentations !== null
      ? item.augmentations as RuntimeAugmentations
      : undefined,
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : undefined,
  };
}

export async function getRuntimeContract(avatarId: string): Promise<RuntimeContract> {
  const stateTable = process.env.STATE_TABLE;
  if (!stateTable) {
    logger.warn('STATE_TABLE not set, using free tier limits');
    return FREE_TIER_LIMITS;
  }

  // Check cache
  const cached = limitsCache.get(avatarId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.contract;
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
      const contract = toRuntimeContract(result.Item as Record<string, unknown>);
      limitsCache.set(avatarId, { contract, expiresAt: Date.now() + CACHE_TTL_MS });
      return contract;
    }
  } catch (err) {
    logger.warn('Failed to fetch runtime limits, using free tier', {
      avatarId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Default to free tier
  limitsCache.set(avatarId, { contract: FREE_TIER_LIMITS, expiresAt: Date.now() + CACHE_TTL_MS });
  return FREE_TIER_LIMITS;
}

export async function getRuntimeLimits(avatarId: string): Promise<RuntimeLimits> {
  return getRuntimeContract(avatarId);
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
  const contract = await getRuntimeContract(avatarId);
  return checkAndIncrementDailyUsage({
    avatarId,
    counterType: 'messages',
    limit: contract.dailyMessageLimit,
    amount: 1,
    limitReason: 'Daily message limit reached',
  });
}

/**
 * Check if media generation is allowed
 */
export async function checkMediaLimit(avatarId: string): Promise<EnforcementResult> {
  const stateTable = process.env.STATE_TABLE;
  if (!stateTable) {
    return { allowed: true };
  }

  const limits = await getRuntimeContract(avatarId);
  
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
 * Track and check media generation limit.
 * This is the authoritative runtime gatekeeper for media tools.
 */
export async function checkAndIncrementMediaUsage(avatarId: string): Promise<EnforcementResult> {
  const contract = await getRuntimeContract(avatarId);
  return checkAndIncrementDailyUsage({
    avatarId,
    counterType: 'media',
    limit: contract.dailyMediaCredits,
    amount: 1,
    limitReason: 'Daily media generation limit reached',
  });
}

/**
 * Increment media usage after successful generation
 */
export async function incrementMediaUsage(avatarId: string): Promise<void> {
  await incrementUsageCounter(avatarId, 'media');
}

/**
 * Track and check voice generation limit.
 * Voice usage is measured in whole-minute units.
 */
export async function checkAndIncrementVoiceUsage(
  avatarId: string,
  minutes = 1
): Promise<EnforcementResult> {
  const contract = await getRuntimeContract(avatarId);
  const units = Number.isFinite(minutes) ? Math.max(1, Math.ceil(minutes)) : 1;
  return checkAndIncrementDailyUsage({
    avatarId,
    counterType: 'voice',
    limit: contract.dailyVoiceMinutes,
    amount: units,
    limitReason: 'Daily voice generation limit reached',
  });
}

/**
 * Check if memory writes are allowed for this avatar
 */
export async function isMemoryWriteAllowed(avatarId: string): Promise<boolean> {
  const limits = await getRuntimeContract(avatarId);
  return limits.memoryEnabled;
}

/**
 * Check tool call limit for a message
 */
export async function checkToolCallLimit(
  avatarId: string,
  currentToolCalls: number
): Promise<EnforcementResult> {
  const limits = await getRuntimeContract(avatarId);
  
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

export interface RuntimeUsageSnapshot {
  date: string;
  messages: number;
  media: number;
  voice: number;
  tools: number;
}

export async function getRuntimeUsageSnapshot(
  avatarId: string,
  date: string = getTodayString()
): Promise<RuntimeUsageSnapshot> {
  const [messages, media, voice, tools] = await Promise.all([
    getUsageCounter(avatarId, 'messages', date),
    getUsageCounter(avatarId, 'media', date),
    getUsageCounter(avatarId, 'voice', date),
    getUsageCounter(avatarId, 'tools', date),
  ]);

  return {
    date,
    messages,
    media,
    voice,
    tools,
  };
}

// ============================================================================
// Usage Counter Helpers
// ============================================================================

async function checkAndIncrementDailyUsage(params: {
  avatarId: string;
  counterType: 'messages' | 'media' | 'voice';
  limit: number;
  amount: number;
  limitReason: string;
}): Promise<EnforcementResult> {
  const stateTable = process.env.STATE_TABLE;
  if (!stateTable) {
    return { allowed: true };
  }

  const { avatarId, counterType, limit, amount, limitReason } = params;
  const normalizedAmount = Number.isFinite(amount) ? Math.max(1, Math.floor(amount)) : 1;
  const dateStr = getTodayString();

  if (limit === -1) {
    const current = await incrementUsageCounter(avatarId, counterType, normalizedAmount);
    return { allowed: true, limit, current };
  }

  if (limit < normalizedAmount) {
    const current = await getUsageCounter(avatarId, counterType, dateStr);
    return {
      allowed: false,
      reason: limitReason,
      limit,
      current,
    };
  }

  const ttl = Math.floor(Date.now() / 1000) + (35 * 24 * 60 * 60);
  const maxBeforeIncrement = limit - normalizedAmount;

  try {
    const result = await dynamoClient.send(new UpdateCommand({
      TableName: stateTable,
      Key: {
        pk: `USAGE#${avatarId}`,
        sk: `${counterType.toUpperCase()}#${dateStr}`,
      },
      ConditionExpression: 'attribute_not_exists(#count) OR #count <= :maxBeforeIncrement',
      UpdateExpression: `
        SET #count = if_not_exists(#count, :zero) + :amount,
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
        ':amount': normalizedAmount,
        ':maxBeforeIncrement': maxBeforeIncrement,
        ':avatarId': avatarId,
        ':date': dateStr,
        ':ttl': ttl,
        ':now': Date.now(),
      },
      ReturnValues: 'ALL_NEW',
    }));

    const current = (result.Attributes?.count as number | undefined) ?? normalizedAmount;
    return { allowed: true, limit, current };
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'ConditionalCheckFailedException') {
      const current = await getUsageCounter(avatarId, counterType, dateStr);
      logger.warn('Usage limit reached', {
        avatarId,
        counterType,
        current,
        limit,
      });
      return {
        allowed: false,
        reason: limitReason,
        limit,
        current,
      };
    }

    logger.warn('Failed to enforce usage limit; allowing request', {
      avatarId,
      counterType,
      error: err instanceof Error ? err.message : String(err),
    });
    return { allowed: true };
  }
}

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
  counterType: 'messages' | 'media' | 'voice' | 'tools',
  amount = 1
): Promise<number | undefined> {
  const stateTable = process.env.STATE_TABLE;
  if (!stateTable) return undefined;

  const dateStr = getTodayString();
  // TTL: 35 days from today
  const ttl = Math.floor(Date.now() / 1000) + (35 * 24 * 60 * 60);
  const normalizedAmount = Number.isFinite(amount) ? Math.max(1, Math.floor(amount)) : 1;

  try {
    const result = await dynamoClient.send(new UpdateCommand({
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
        ':one': normalizedAmount,
        ':avatarId': avatarId,
        ':date': dateStr,
        ':ttl': ttl,
        ':now': Date.now(),
      },
      ReturnValues: 'ALL_NEW',
    }));
    return result.Attributes?.count as number | undefined;
  } catch (err) {
    logger.warn('Failed to increment usage counter', {
      avatarId,
      counterType,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
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
