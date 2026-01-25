/**
 * Observability Service
 *
 * Aggregates system status and per-avatar activity for admin tools and APIs.
 */
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import * as avatarLogs from './avatar-logs.js';
import * as autoIssues from './auto-issues.js';
import * as avatarEvents from './avatar-events.js';
import * as mediaJobs from './media-jobs.js';
import * as credits from './credits.js';

const POST_QUEUE_URL = process.env.POST_QUEUE_URL;
const sqsClient = POST_QUEUE_URL ? new SQSClient({}) : null;

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SystemStatusOptions {
  since?: number;
  avatarId?: string;
}

export interface SystemStatusResult {
  timestamp: number;
  window: { since: number; until: number };
  errors: {
    errorCount: number;
    warnCount: number;
    truncated: boolean;
  };
  autoIssues: {
    openTotal: number;
    bySeverity: Record<autoIssues.IssueSeverity, number>;
    sampled: boolean;
    sampleLimit: number;
  };
  queues: {
    postQueue?: {
      depth?: number;
      inFlight?: number;
      unavailable?: boolean;
    };
  };
  toolCredits?: Record<string, credits.ToolCreditStatus>;
  energy?: { current: number; max: number; nextRefillIn: number };
  rateLimit?: { available: boolean; source: string; details?: Record<string, unknown> };
}

export interface ActivityItemBase {
  timestamp: number;
  type: 'log' | 'event' | 'job';
}

export interface ActivityLogItem extends ActivityItemBase {
  type: 'log';
  level: avatarLogs.LogLevel;
  subsystem: string;
  event: string;
  message: string;
  requestId?: string;
  data?: Record<string, unknown>;
}

export interface ActivityEventItem extends ActivityItemBase {
  type: 'event';
  eventType: avatarEvents.EventType;
  severity?: avatarEvents.IssueSeverity;
  status?: avatarEvents.IssueStatus;
  sentiment?: avatarEvents.FeedbackSentiment;
  title?: string;
  description?: string;
  feature?: string;
}

export interface ActivityJobItem extends ActivityItemBase {
  type: 'job';
  jobId: string;
  status: string;
  jobType: string;
  prompt?: string;
}

export type ActivityItem = ActivityLogItem | ActivityEventItem | ActivityJobItem;

export interface AvatarActivityOptions {
  since?: number;
  limit?: number;
}

export interface AvatarActivityResult {
  avatarId: string;
  window: { since: number; until: number };
  items: ActivityItem[];
  summary: {
    errorCount: number;
    warnCount: number;
    issueCount: number;
    feedbackCount: number;
    pendingJobs: number;
  };
}

async function getPostQueueDepth(): Promise<{ depth?: number; inFlight?: number; unavailable?: boolean }> {
  if (!POST_QUEUE_URL || !sqsClient) {
    return { unavailable: true };
  }

  let response: { Attributes?: Record<string, string> } | undefined;
  try {
    response = await sqsClient.send(new GetQueueAttributesCommand({
      QueueUrl: POST_QUEUE_URL,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }));
  } catch {
    return { unavailable: true };
  }

  const depth = response.Attributes?.ApproximateNumberOfMessages
    ? Number.parseInt(response.Attributes.ApproximateNumberOfMessages, 10)
    : undefined;
  const inFlight = response.Attributes?.ApproximateNumberOfMessagesNotVisible
    ? Number.parseInt(response.Attributes.ApproximateNumberOfMessagesNotVisible, 10)
    : undefined;

  return { depth, inFlight };
}

export async function getSystemStatus(options: SystemStatusOptions = {}): Promise<SystemStatusResult> {
  const now = Date.now();
  const since = options.since ?? (now - DEFAULT_WINDOW_MS);

  const [errorCounts, warnCounts] = await Promise.all([
    avatarLogs.countLogsByLevel('ERROR', { since }),
    avatarLogs.countLogsByLevel('WARN', { since }),
  ]);

  const sampleLimit = 200;
  const openIssues = await autoIssues.listIssues({ status: 'open', limit: sampleLimit });
  const bySeverity: Record<autoIssues.IssueSeverity, number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  for (const issue of openIssues) {
    if (issue.severity) {
      bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1;
    }
  }

  const [postQueue, toolCredits, energy] = await Promise.all([
    getPostQueueDepth(),
    options.avatarId ? credits.getToolStatusStructured(options.avatarId) : Promise.resolve(undefined),
    options.avatarId ? credits.getEnergyStatus(options.avatarId) : Promise.resolve(undefined),
  ]);

  return {
    timestamp: now,
    window: { since, until: now },
    errors: {
      errorCount: errorCounts.count,
      warnCount: warnCounts.count,
      truncated: errorCounts.truncated || warnCounts.truncated,
    },
    autoIssues: {
      openTotal: openIssues.length,
      bySeverity,
      sampled: openIssues.length >= sampleLimit,
      sampleLimit,
    },
    queues: {
      postQueue,
    },
    ...(toolCredits ? { toolCredits } : {}),
    ...(energy ? { energy } : {}),
    rateLimit: {
      available: false,
      source: 'unavailable',
    },
  };
}

export async function getAvatarActivity(
  avatarId: string,
  options: AvatarActivityOptions = {}
): Promise<AvatarActivityResult> {
  const now = Date.now();
  const since = options.since ?? (now - DEFAULT_WINDOW_MS);
  const limit = Math.min(options.limit ?? 100, 500);

  const [logsResult, events, pendingJobs] = await Promise.all([
    avatarLogs.listAvatarLogs(avatarId, { since, limit: Math.min(limit * 2, 500) }),
    avatarEvents.listAvatarEvents(avatarId, { since, limit: Math.min(limit, 200) }),
    mediaJobs.getPendingJobs(avatarId),
  ]);

  const logItems: ActivityLogItem[] = logsResult.logs.map(log => ({
    type: 'log',
    timestamp: log.timestamp,
    level: log.level,
    subsystem: log.subsystem,
    event: log.event,
    message: log.message,
    requestId: log.requestId,
    data: log.data,
  }));

  const eventItems: ActivityEventItem[] = events.map(event => ({
    type: 'event',
    timestamp: event.timestamp,
    eventType: event.type,
    severity: event.type === 'issue' ? event.severity : undefined,
    status: event.type === 'issue' ? event.status : undefined,
    sentiment: event.type === 'feedback' ? event.sentiment : undefined,
    title: event.type === 'issue' ? event.title : undefined,
    description: event.type === 'issue' ? event.description : undefined,
    feature: event.type === 'feedback' ? event.feature : undefined,
  }));

  const jobItems: ActivityJobItem[] = pendingJobs.map(job => ({
    type: 'job',
    timestamp: job.updatedAt || job.createdAt,
    jobId: job.jobId,
    status: job.status,
    jobType: job.type,
    prompt: job.prompt,
  }));

  const combined = [...logItems, ...eventItems, ...jobItems]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);

  const summary = {
    errorCount: logItems.filter(item => item.level === 'ERROR').length,
    warnCount: logItems.filter(item => item.level === 'WARN').length,
    issueCount: eventItems.filter(item => item.eventType === 'issue').length,
    feedbackCount: eventItems.filter(item => item.eventType === 'feedback').length,
    pendingJobs: pendingJobs.length,
  };

  return {
    avatarId,
    window: { since, until: now },
    items: combined,
    summary,
  };
}
