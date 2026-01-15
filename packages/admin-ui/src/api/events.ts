/**
 * Agent Events API - Issues and feedback from DynamoDB (fast)
 */
const API_BASE = import.meta.env.VITE_API_URL || '/api';

export type EventType = 'issue' | 'feedback';
export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical';
export type IssueStatus = 'open' | 'acknowledged' | 'resolved' | 'wont_fix';
export type FeedbackSentiment = 'positive' | 'negative' | 'neutral';

export interface AgentIssueEvent {
  id: string;
  type: 'issue';
  timestamp: number;
  agentId: string;
  platform: string;
  severity: IssueSeverity;
  category: string;
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

export interface AgentFeedbackEvent {
  id: string;
  type: 'feedback';
  timestamp: number;
  agentId: string;
  platform: string;
  sentiment: FeedbackSentiment;
  feature: string;
  feedback: string;
}

export type AgentEvent = AgentIssueEvent | AgentFeedbackEvent;

export interface AgentEventsResponse {
  agentId: string;
  events: AgentEvent[];
  count: number;
}

export interface EventCountsResponse {
  agentId: string;
  openIssues: number;
  recentFeedback: {
    positive: number;
    negative: number;
    neutral: number;
  };
}

export interface ListEventsOptions {
  type?: EventType;
  limit?: number;
  since?: number;
  severity?: IssueSeverity;
  sentiment?: FeedbackSentiment;
  status?: IssueStatus;
}

/**
 * Fetch events for an agent (issues + feedback) from DynamoDB
 */
export async function fetchAgentEvents(
  agentId: string,
  options: ListEventsOptions = {}
): Promise<AgentEventsResponse> {
  const params = new URLSearchParams();

  if (options.type) params.set('type', options.type);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.since) params.set('since', String(options.since));
  if (options.severity) params.set('severity', options.severity);
  if (options.sentiment) params.set('sentiment', options.sentiment);
  if (options.status) params.set('status', options.status);

  const url = `${API_BASE}/agents/${agentId}/events${params.toString() ? `?${params}` : ''}`;

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

/**
 * Fetch event counts for dashboard
 */
export async function fetchEventCounts(agentId: string): Promise<EventCountsResponse> {
  const response = await fetch(`${API_BASE}/agents/${agentId}/events/counts`, {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Update an issue's status
 */
export async function updateEventStatus(
  agentId: string,
  eventId: string,
  status: IssueStatus
): Promise<void> {
  const response = await fetch(`${API_BASE}/agents/${agentId}/events/${eventId}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
}
