/**
 * Agent Logs Service
 * 
 * Fast log storage in DynamoDB for real-time log viewing.
 * Complements CloudWatch Logs with instant access to recent logs.
 * 
 * Schema:
 *   pk: AGENT#<agentId>
 *   sk: LOG#<timestamp>#<random>
 *   gsi1pk: LOGS#<level>  (for cross-agent error queries)
 *   gsi1sk: <timestamp>
 * 
 * Design:
 *   - Stores last 24h of structured logs per agent
 *   - TTL auto-deletes old entries
 *   - CloudWatch remains source of truth for long-term audit
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ADMIN_TABLE = process.env.ADMIN_TABLE || 'swarm-admin';

// Log TTL: 24 hours (logs are for real-time debugging, CloudWatch has long-term)
const LOG_TTL_SECONDS = 24 * 60 * 60;

// Max logs to store per write batch
const MAX_BATCH_SIZE = 25;

// ============================================================================
// Types
// ============================================================================

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface AgentLogEntry {
  id: string;
  timestamp: number;
  agentId: string;
  level: LogLevel;
  subsystem: string;
  event: string;
  message: string;
  data?: Record<string, unknown>;
  requestId?: string;
  platform?: string;
}

export interface LogQueryOptions {
  level?: LogLevel;
  subsystem?: string;
  since?: number; // timestamp ms
  limit?: number;
  query?: string; // text search
}

// ============================================================================
// Write Operations  
// ============================================================================

/**
 * Record a structured log entry
 */
export async function recordLog(params: {
  agentId: string;
  level: LogLevel;
  subsystem: string;
  event: string;
  message?: string;
  data?: Record<string, unknown>;
  requestId?: string;
  platform?: string;
}): Promise<AgentLogEntry> {
  const now = Date.now();
  const id = `log-${now}-${Math.random().toString(36).slice(2, 8)}`;
  
  const entry: AgentLogEntry = {
    id,
    timestamp: now,
    agentId: params.agentId,
    level: params.level,
    subsystem: params.subsystem,
    event: params.event,
    message: params.message || params.event,
    data: params.data,
    requestId: params.requestId,
    platform: params.platform,
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: {
      pk: `AGENT#${params.agentId}`,
      sk: `LOG#${now}#${id.slice(-6)}`,
      gsi1pk: `LOGS#${params.level}`,
      gsi1sk: now,
      ttl: Math.floor(now / 1000) + LOG_TTL_SECONDS,
      ...entry,
    },
  }));

  return entry;
}

/**
 * Record multiple log entries in batch
 */
export async function recordLogBatch(
  entries: Array<Omit<Parameters<typeof recordLog>[0], 'timestamp'>>
): Promise<void> {
  if (entries.length === 0) return;

  const now = Date.now();
  const items = entries.slice(0, MAX_BATCH_SIZE).map((params, idx) => {
    const id = `log-${now}-${idx}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      PutRequest: {
        Item: {
          pk: `AGENT#${params.agentId}`,
          sk: `LOG#${now + idx}#${id.slice(-6)}`,
          gsi1pk: `LOGS#${params.level}`,
          gsi1sk: now + idx,
          ttl: Math.floor(now / 1000) + LOG_TTL_SECONDS,
          id,
          timestamp: now + idx,
          agentId: params.agentId,
          level: params.level,
          subsystem: params.subsystem,
          event: params.event,
          message: params.message || params.event,
          data: params.data,
          requestId: params.requestId,
          platform: params.platform,
        },
      },
    };
  });

  await dynamoClient.send(new BatchWriteCommand({
    RequestItems: {
      [ADMIN_TABLE]: items,
    },
  }));
}

// ============================================================================
// Read Operations
// ============================================================================

/**
 * List logs for a specific agent (fast)
 */
export async function listAgentLogs(
  agentId: string,
  options: LogQueryOptions = {}
): Promise<{ logs: AgentLogEntry[]; hasMore: boolean }> {
  const limit = Math.min(options.limit || 200, 500);
  const since = options.since || (Date.now() - 24 * 60 * 60 * 1000); // Default: 24h

  // Build filter expression
  const filterParts: string[] = [];
  const exprNames: Record<string, string> = {};
  const exprValues: Record<string, unknown> = {
    ':pk': `AGENT#${agentId}`,
    ':skPrefix': `LOG#${since}`,
  };

  if (options.level) {
    filterParts.push('#level = :level');
    exprNames['#level'] = 'level';
    exprValues[':level'] = options.level;
  }

  if (options.subsystem) {
    filterParts.push('subsystem = :subsystem');
    exprValues[':subsystem'] = options.subsystem;
  }

  if (options.query) {
    // Simple text search in message
    filterParts.push('contains(message, :query)');
    exprValues[':query'] = options.query;
  }

  const result = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk AND sk >= :skPrefix',
    FilterExpression: filterParts.length ? filterParts.join(' AND ') : undefined,
    ExpressionAttributeNames: Object.keys(exprNames).length ? exprNames : undefined,
    ExpressionAttributeValues: exprValues,
    Limit: limit + 1, // Fetch one extra to detect hasMore
    ScanIndexForward: false, // Newest first
  }));

  const items = (result.Items || []) as AgentLogEntry[];
  const hasMore = items.length > limit;
  
  return {
    logs: items.slice(0, limit),
    hasMore,
  };
}

/**
 * List logs by level across all agents (for error dashboard)
 */
export async function listLogsByLevel(
  level: LogLevel,
  options: Omit<LogQueryOptions, 'level'> = {}
): Promise<{ logs: AgentLogEntry[]; hasMore: boolean }> {
  const limit = Math.min(options.limit || 100, 500);
  const since = options.since || (Date.now() - 24 * 60 * 60 * 1000);

  const filterParts: string[] = [];
  const exprValues: Record<string, unknown> = {
    ':gsi1pk': `LOGS#${level}`,
    ':since': since,
  };

  if (options.subsystem) {
    filterParts.push('subsystem = :subsystem');
    exprValues[':subsystem'] = options.subsystem;
  }

  if (options.query) {
    filterParts.push('contains(message, :query)');
    exprValues[':query'] = options.query;
  }

  const result = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :gsi1pk AND gsi1sk >= :since',
    FilterExpression: filterParts.length ? filterParts.join(' AND ') : undefined,
    ExpressionAttributeValues: exprValues,
    Limit: limit + 1,
    ScanIndexForward: false,
  }));

  const items = (result.Items || []) as AgentLogEntry[];
  const hasMore = items.length > limit;
  
  return {
    logs: items.slice(0, limit),
    hasMore,
  };
}

/**
 * Get log counts by level for an agent (for dashboard badges)
 */
export async function getAgentLogCounts(
  agentId: string,
  since?: number
): Promise<{ ERROR: number; WARN: number; INFO: number; DEBUG: number }> {
  const sincetime = since || (Date.now() - 60 * 60 * 1000); // Default: 1 hour
  const { logs } = await listAgentLogs(agentId, { since: sincetime, limit: 500 });

  const counts = { ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0 };
  for (const log of logs) {
    counts[log.level]++;
  }

  return counts;
}

// ============================================================================
// Utility: Parse and store from console.log JSON
// ============================================================================

/**
 * Parse a structured log JSON string and store it
 * Call this from handlers that want fast log access
 */
export async function parseAndStorelog(
  agentId: string,
  jsonString: string,
  platform?: string
): Promise<AgentLogEntry | null> {
  try {
    const parsed = JSON.parse(jsonString);
    if (!parsed.level || !parsed.subsystem || !parsed.event) {
      return null; // Not a structured log
    }

    return await recordLog({
      agentId,
      level: (parsed.level?.toUpperCase() || 'INFO') as LogLevel,
      subsystem: parsed.subsystem,
      event: parsed.event,
      message: parsed.message || parsed.event,
      data: parsed,
      requestId: parsed.requestId,
      platform: platform || parsed.platform,
    });
  } catch {
    return null;
  }
}
