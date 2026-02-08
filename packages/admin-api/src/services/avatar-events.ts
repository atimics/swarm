/**
 * Avatar Events Service
 * 
 * Stores and retrieves avatar-reported issues and feedback in DynamoDB
 * for fast access. CloudWatch logs remain the source of truth for audit.
 * 
 * Schema:
 *   pk: AVATAR#<avatarId>
 *   sk: EVENT#<timestamp>#<type>
 *   gsi1pk: EVENTS#<type>  (for cross-avatar queries)
 *   gsi1sk: <timestamp>
 */
import {
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { getDynamoClient } from './dynamo-client.js';

const dynamoClient = getDynamoClient();
const ADMIN_TABLE = process.env.ADMIN_TABLE || 'swarm-admin';

// Event TTL: 30 days
const EVENT_TTL_SECONDS = 30 * 24 * 60 * 60;

// ============================================================================
// Types
// ============================================================================

export type EventType = 'issue' | 'feedback';
export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical';
export type IssueCategory = 
  | 'ui_glitch'
  | 'missing_data'
  | 'timing_issue'
  | 'tool_failure'
  | 'user_experience'
  | 'unexpected_behavior'
  | 'performance'
  | 'other';
export type IssueStatus = 'open' | 'acknowledged' | 'resolved' | 'wont_fix';
export type FeedbackSentiment = 'positive' | 'negative' | 'neutral';

export interface AvatarIssueEvent {
  id: string;
  type: 'issue';
  timestamp: number;
  avatarId: string;
  platform: string;
  severity: IssueSeverity;
  category: IssueCategory;
  title: string;
  description: string;
  userMessage?: string;
  context?: {
    toolName?: string;
    expectedBehavior?: string;
    actualBehavior?: string;
    reproSteps?: string[];
  };
  status: IssueStatus;
  resolvedAt?: number;
  resolvedBy?: string;
}

export interface AvatarFeedbackEvent {
  id: string;
  type: 'feedback';
  timestamp: number;
  avatarId: string;
  platform: string;
  sentiment: FeedbackSentiment;
  feature: string;
  feedback: string;
}

export type AvatarEvent = AvatarIssueEvent | AvatarFeedbackEvent;

// ============================================================================
// Write Operations
// ============================================================================

/**
 * Record an avatar-reported issue
 */
export async function recordIssue(params: {
  avatarId: string;
  platform: string;
  severity: IssueSeverity;
  category: IssueCategory;
  title: string;
  description: string;
  userMessage?: string;
  context?: AvatarIssueEvent['context'];
}): Promise<AvatarIssueEvent> {
  const now = Date.now();
  const id = `issue-${now}-${Math.random().toString(36).slice(2, 8)}`;
  
  const event: AvatarIssueEvent = {
    id,
    type: 'issue',
    timestamp: now,
    avatarId: params.avatarId,
    platform: params.platform,
    severity: params.severity,
    category: params.category,
    title: params.title,
    description: params.description,
    userMessage: params.userMessage,
    context: params.context,
    status: 'open',
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: {
      pk: `AVATAR#${params.avatarId}`,
      sk: `EVENT#${now}#issue`,
      gsi1pk: 'EVENTS#issue',
      gsi1sk: now,
      ttl: Math.floor(now / 1000) + EVENT_TTL_SECONDS,
      ...event,
    },
  }));

  return event;
}

/**
 * Record avatar-reported feedback
 */
export async function recordFeedback(params: {
  avatarId: string;
  platform: string;
  sentiment: FeedbackSentiment;
  feature: string;
  feedback: string;
}): Promise<AvatarFeedbackEvent> {
  const now = Date.now();
  const id = `feedback-${now}-${Math.random().toString(36).slice(2, 8)}`;
  
  const event: AvatarFeedbackEvent = {
    id,
    type: 'feedback',
    timestamp: now,
    avatarId: params.avatarId,
    platform: params.platform,
    sentiment: params.sentiment,
    feature: params.feature,
    feedback: params.feedback,
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: {
      pk: `AVATAR#${params.avatarId}`,
      sk: `EVENT#${now}#feedback`,
      gsi1pk: 'EVENTS#feedback',
      gsi1sk: now,
      ttl: Math.floor(now / 1000) + EVENT_TTL_SECONDS,
      ...event,
    },
  }));

  return event;
}

// ============================================================================
// Read Operations
// ============================================================================

export interface ListEventsOptions {
  type?: EventType;
  limit?: number;
  since?: number; // timestamp
  severity?: IssueSeverity; // for issues only
  sentiment?: FeedbackSentiment; // for feedback only
  status?: IssueStatus; // for issues only
}

/**
 * List events for a specific avatar
 */
export async function listAvatarEvents(
  avatarId: string,
  options: ListEventsOptions = {}
): Promise<AvatarEvent[]> {
  const limit = Math.min(options.limit || 100, 500);
  const since = options.since || (Date.now() - 7 * 24 * 60 * 60 * 1000); // Default: 7 days

  // Build filter expression
  const filterParts: string[] = [];
  const exprNames: Record<string, string> = {};
  const exprValues: Record<string, unknown> = {
    ':pk': `AVATAR#${avatarId}`,
    ':skPrefix': `EVENT#${since}`,
  };

  if (options.type) {
    filterParts.push('#type = :type');
    exprNames['#type'] = 'type';
    exprValues[':type'] = options.type;
  }

  if (options.severity) {
    filterParts.push('severity = :severity');
    exprValues[':severity'] = options.severity;
  }

  if (options.sentiment) {
    filterParts.push('sentiment = :sentiment');
    exprValues[':sentiment'] = options.sentiment;
  }

  if (options.status) {
    filterParts.push('#status = :status');
    exprNames['#status'] = 'status';
    exprValues[':status'] = options.status;
  }

  const result = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk AND sk >= :skPrefix',
    FilterExpression: filterParts.length ? filterParts.join(' AND ') : undefined,
    ExpressionAttributeNames: Object.keys(exprNames).length ? exprNames : undefined,
    ExpressionAttributeValues: exprValues,
    Limit: limit,
    ScanIndexForward: false, // newest first
  }));

  return (result.Items || []) as AvatarEvent[];
}

/**
 * List all events across avatars (admin view)
 */
export async function listAllEvents(
  type: EventType,
  options: Omit<ListEventsOptions, 'type'> = {}
): Promise<AvatarEvent[]> {
  const limit = Math.min(options.limit || 100, 500);
  const since = options.since || (Date.now() - 7 * 24 * 60 * 60 * 1000);

  const filterParts: string[] = [];
  const exprNames: Record<string, string> = {};
  const exprValues: Record<string, unknown> = {
    ':gsi1pk': `EVENTS#${type}`,
    ':since': since,
  };

  if (options.severity) {
    filterParts.push('severity = :severity');
    exprValues[':severity'] = options.severity;
  }

  if (options.sentiment) {
    filterParts.push('sentiment = :sentiment');
    exprValues[':sentiment'] = options.sentiment;
  }

  if (options.status) {
    filterParts.push('#status = :status');
    exprNames['#status'] = 'status';
    exprValues[':status'] = options.status;
  }

  const result = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :gsi1pk AND gsi1sk >= :since',
    FilterExpression: filterParts.length ? filterParts.join(' AND ') : undefined,
    ExpressionAttributeNames: Object.keys(exprNames).length ? exprNames : undefined,
    ExpressionAttributeValues: exprValues,
    Limit: limit,
    ScanIndexForward: false,
  }));

  return (result.Items || []) as AvatarEvent[];
}

/**
 * Get event counts for an avatar (for dashboard)
 */
export async function getAvatarEventCounts(avatarId: string): Promise<{
  openIssues: number;
  recentFeedback: { positive: number; negative: number; neutral: number };
}> {
  const since = Date.now() - 24 * 60 * 60 * 1000; // 24 hours
  const events = await listAvatarEvents(avatarId, { since, limit: 500 });

  let openIssues = 0;
  const feedback = { positive: 0, negative: 0, neutral: 0 };

  for (const event of events) {
    if (event.type === 'issue' && event.status === 'open') {
      openIssues++;
    } else if (event.type === 'feedback') {
      feedback[event.sentiment]++;
    }
  }

  return { openIssues, recentFeedback: feedback };
}

// ============================================================================
// Update Operations
// ============================================================================

/**
 * Update issue status
 */
export async function updateIssueStatus(
  avatarId: string,
  issueId: string,
  status: IssueStatus,
  resolvedBy?: string
): Promise<void> {
  // Find the issue by ID
  const events = await listAvatarEvents(avatarId, { type: 'issue', limit: 500 });
  const issue = events.find(e => e.id === issueId) as AvatarIssueEvent | undefined;
  
  if (!issue) {
    throw new Error(`Issue not found: ${issueId}`);
  }

  const updates: Record<string, unknown> = {
    ':status': status,
  };
  const exprParts = ['#status = :status'];
  const exprNames: Record<string, string> = { '#status': 'status' };

  if (status === 'resolved' || status === 'wont_fix') {
    updates[':resolvedAt'] = Date.now();
    exprParts.push('resolvedAt = :resolvedAt');
    if (resolvedBy) {
      updates[':resolvedBy'] = resolvedBy;
      exprParts.push('resolvedBy = :resolvedBy');
    }
  }

  await dynamoClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: `EVENT#${issue.timestamp}#issue`,
    },
    UpdateExpression: `SET ${exprParts.join(', ')}`,
    ExpressionAttributeNames: exprNames,
    ExpressionAttributeValues: updates,
  }));
}
