/**
 * Logs API - Consolidated avatar logs endpoint.
 */
const API_BASE = import.meta.env.VITE_API_URL || '/api';

// CloudWatch log event format
export interface AvatarLogEvent {
  timestamp?: string;
  message?: string;
  logGroup?: string;
  logStream?: string;
}

// DynamoDB fast log format
export interface FastLogEntry {
  id: string;
  timestamp: number;
  avatarId: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  subsystem: string;
  event: string;
  message: string;
  data?: Record<string, unknown>;
  requestId?: string;
  platform?: string;
}

export interface AvatarLogResponse {
  avatarId: string;
  startTime?: number;
  endTime?: number;
  logGroups?: string[];
  filters?: {
    level?: string;
    subsystem?: string;
    query?: string;
    limit: number;
  };
  events?: AvatarLogEvent[];
  // Fast logs response
  logs?: FastLogEntry[];
  hasMore?: boolean;
  source?: 'cloudwatch' | 'dynamodb';
}

export interface LogQueryOptions {
  level?: string;
  subsystem?: string;
  since?: string;
  limit?: number;
  query?: string;
  start?: number;
  end?: number;
  fast?: boolean; // Use DynamoDB instead of CloudWatch
}

export async function fetchAvatarLogs(
  avatarId: string,
  options: LogQueryOptions = {}
): Promise<AvatarLogResponse> {
  const params = new URLSearchParams();

  if (options.fast) params.set('fast', 'true');
  if (options.level) params.set('level', options.level);
  if (options.subsystem) params.set('subsystem', options.subsystem);
  if (options.since) params.set('since', options.since);
  if (options.query) params.set('query', options.query);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.start) params.set('start', String(options.start));
  if (options.end) params.set('end', String(options.end));

  const url = `${API_BASE}/avatars/${avatarId}/logs${params.toString() ? `?${params}` : ''}`;

  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}
