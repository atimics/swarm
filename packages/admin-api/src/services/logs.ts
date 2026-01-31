/**
 * CloudWatch Logs query helper for consolidated avatar logs.
 */
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  StartQueryCommand,
  GetQueryResultsCommand,
  type QueryStatus,
} from '@aws-sdk/client-cloudwatch-logs';

/**
 * Dependencies interface for logs service (for testing)
 */
export interface LogsServiceDeps {
  logsClient: Pick<CloudWatchLogsClient, 'send'>;
  logGroupPrefix: string;
  adminLogGroups: string[];
  adminLogGroupPrefixes: string[];
}

const defaultLogsClient = new CloudWatchLogsClient({});

const DEFAULT_LOOKBACK_MINUTES = 30;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

const LOG_GROUP_PREFIX = process.env.LOG_GROUP_PREFIX || '/aws/lambda/';
const ADMIN_LOG_GROUPS = (process.env.ADMIN_LOG_GROUPS || '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const ADMIN_LOG_GROUP_PREFIXES = (process.env.ADMIN_LOG_GROUP_PREFIXES || '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);

// Default dependencies
const defaultDeps: LogsServiceDeps = {
  logsClient: defaultLogsClient,
  logGroupPrefix: LOG_GROUP_PREFIX,
  adminLogGroups: ADMIN_LOG_GROUPS,
  adminLogGroupPrefixes: ADMIN_LOG_GROUP_PREFIXES,
};

export interface LogQueryOptions {
  level?: string;
  subsystem?: string;
  since?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
  query?: string;
}

export interface AvatarLogEvent {
  timestamp?: string;
  message?: string;
  logGroup?: string;
  logStream?: string;
}

export interface AvatarLogResult {
  avatarId: string;
  startTime: number;
  endTime: number;
  logGroups: string[];
  filters: {
    level?: string;
    subsystem?: string;
    query?: string;
    limit: number;
  };
  events: AvatarLogEvent[];
}

function clampLimit(limit?: number): number {
  if (!limit || Number.isNaN(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(limit, MAX_LIMIT));
}

function parseSince(since?: string): number | null {
  if (!since) return null;
  const match = since.trim().match(/^(\d+)(m|h|d)$/i);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  if (!value) return null;
  const unit = match[2].toLowerCase();
  if (unit === 'm') return value * 60 * 1000;
  if (unit === 'h') return value * 60 * 60 * 1000;
  if (unit === 'd') return value * 24 * 60 * 60 * 1000;
  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildInsightsQuery(avatarId: string, options: LogQueryOptions, limit: number): string {
  const filters: string[] = [];
  const escapedAgent = escapeRegex(avatarId);
  filters.push(
    `(@message like /"avatarId"\\s*:\\s*"${escapedAgent}"/ or @message like /avatarId=${escapedAgent}/ or @message like /avatarId:\\s*['"]?${escapedAgent}/)`
  );

  if (options.level) {
    const upperLevel = options.level.toUpperCase();
    const lowerLevel = options.level.toLowerCase();
    const escapedUpper = escapeRegex(upperLevel);
    const escapedLower = escapeRegex(lowerLevel);
    filters.push(
      `(@message like /"level"\\s*:\\s*"${escapedUpper}"/ or @message like /"level"\\s*:\\s*"${escapedLower}"/ or @message like /level=${escapedLower}/ or @message like /level=${escapedUpper}/)`
    );
  }

  if (options.subsystem) {
    const escapedSubsystem = escapeRegex(options.subsystem);
    filters.push(
      `(@log like /${escapedSubsystem}/ or @message like /"subsystem"\\s*:\\s*"${escapedSubsystem}"/ or @message like /"component"\\s*:\\s*"${escapedSubsystem}"/ or @message like /subsystem=${escapedSubsystem}/)`
    );
  }

  if (options.query) {
    const escapedQuery = escapeRegex(options.query);
    filters.push(`@message like /${escapedQuery}/`);
  }

  const filterClause = filters.length ? `| filter ${filters.join(' and ')}` : '';

  return [
    'fields @timestamp, @message, @log, @logStream',
    filterClause,
    '| sort @timestamp desc',
    `| limit ${limit}`,
  ].join('\n');
}

async function describeLogGroups(prefix: string, deps: LogsServiceDeps): Promise<string[]> {
  const names: string[] = [];
  let nextToken: string | undefined;

  do {
    const response = await deps.logsClient.send(new DescribeLogGroupsCommand({
      logGroupNamePrefix: prefix,
      nextToken,
    })) as {
      logGroups?: Array<{ logGroupName?: string }>;
      nextToken?: string;
    };

    for (const group of response.logGroups || []) {
      if (group.logGroupName) {
        names.push(group.logGroupName);
      }
    }
    nextToken = response.nextToken;
  } while (nextToken);

  return names;
}

async function resolveLogGroups(avatarId: string, deps: LogsServiceDeps): Promise<string[]> {
  const logGroups = new Set<string>();

  const avatarrefix = `${deps.logGroupPrefix}${avatarId}-`;
  const avatarroups = await describeLogGroups(avatarrefix, deps);
  avatarroups.forEach((name) => logGroups.add(name));

  for (const group of deps.adminLogGroups) {
    logGroups.add(group);
  }

  for (const prefix of deps.adminLogGroupPrefixes) {
    const groups = await describeLogGroups(prefix, deps);
    groups.forEach((name) => logGroups.add(name));
  }

  return Array.from(logGroups);
}

async function waitForQuery(queryId: string, deps: LogsServiceDeps): Promise<{ status: QueryStatus; results: AvatarLogEvent[] }> {
  const maxAttempts = 20;
  const delayMs = 500;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await deps.logsClient.send(new GetQueryResultsCommand({ queryId })) as {
      status?: QueryStatus;
      results?: Array<Array<{ field?: string; value?: string }>>;
    };
    const status = response.status || 'Failed';

    if (status === 'Complete') {
      const events = (response.results || []).map((row: Array<{ field?: string; value?: string }>) => {
        const event: AvatarLogEvent = {};
        for (const field of row) {
          if (!field.field || field.value === undefined) continue;
          if (field.field === '@timestamp') event.timestamp = field.value;
          if (field.field === '@message') event.message = field.value;
          if (field.field === '@log') event.logGroup = field.value;
          if (field.field === '@logStream') event.logStream = field.value;
        }
        return event;
      });
      return { status, results: events };
    }

    if (status === 'Failed' || status === 'Cancelled') {
      return { status, results: [] };
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return { status: 'Timeout', results: [] };
}

export async function queryAvatarLogs(
  avatarId: string,
  options: LogQueryOptions = {},
  deps: LogsServiceDeps = defaultDeps
): Promise<AvatarLogResult> {
  const now = Date.now();
  const limit = clampLimit(options.limit);
  const sinceMs = parseSince(options.since) ?? (DEFAULT_LOOKBACK_MINUTES * 60 * 1000);
  const startTime = options.startTime ?? (now - sinceMs);
  const endTime = options.endTime ?? now;

  const logGroups = await resolveLogGroups(avatarId, deps);

  if (logGroups.length === 0) {
    return {
      avatarId,
      startTime,
      endTime,
      logGroups: [],
      filters: { level: options.level, subsystem: options.subsystem, query: options.query, limit },
      events: [],
    };
  }

  const queryString = buildInsightsQuery(avatarId, options, limit);

  const startResponse = await deps.logsClient.send(new StartQueryCommand({
    logGroupNames: logGroups,
    startTime: Math.floor(startTime / 1000),
    endTime: Math.floor(endTime / 1000),
    queryString,
  })) as { queryId?: string };

  const queryId = startResponse.queryId;
  if (!queryId) {
    return {
      avatarId,
      startTime,
      endTime,
      logGroups,
      filters: { level: options.level, subsystem: options.subsystem, query: options.query, limit },
      events: [],
    };
  }

  const { results } = await waitForQuery(queryId, deps);

  return {
    avatarId,
    startTime,
    endTime,
    logGroups,
    filters: { level: options.level, subsystem: options.subsystem, query: options.query, limit },
    events: results,
  };
}
