/**
 * Types for Claude Code Worker
 */

export type ClaudeCodeJobStatus =
  | 'pending'
  | 'processing'
  | 'waiting_input'
  | 'completed'
  | 'failed';

/**
 * Message format for the Claude Code queue
 */
export interface ClaudeCodeQueueMessage {
  /** Type of message */
  type: 'task' | 'response';

  /** Unique job ID */
  jobId: string;

  /** Agent ID that owns this job */
  agentId: string;

  /** Conversation ID for callback */
  conversationId?: string;

  /** Message ID to reply to */
  replyToMessageId?: string;

  /** For 'task' type: the task description */
  task?: string;

  /** Working directory */
  workingDir?: string;

  /** Maximum turns for agent */
  maxTurns?: number;

  /** Session ID for resume */
  sessionId?: string;

  /** Allowed tools */
  allowedTools?: string[];

  /** For 'response' type: the user's response */
  response?: string;

  /** Callback queue URL for results */
  callbackQueueUrl: string;
}

/**
 * Callback message sent back to the swarm
 */
export interface ClaudeCodeCallback {
  type: 'claude_code_callback';

  /** Job ID */
  jobId: string;

  /** Agent ID */
  agentId: string;

  /** Conversation ID for routing */
  conversationId?: string;

  /** Message ID to reply to */
  replyToMessageId?: string;

  /** Current status */
  status: ClaudeCodeJobStatus;

  /** Session ID for multi-turn */
  sessionId?: string;

  /** Result text if completed */
  result?: string;

  /** Error message if failed */
  error?: string;

  /** Pending question if waiting_input */
  question?: {
    text: string;
    options: Array<{ label: string; description: string }>;
  };
}

/**
 * DynamoDB record for job state
 */
export interface ClaudeCodeJobRecord {
  pk: string; // AGENT#{agentId}
  sk: string; // CLAUDE_CODE#{jobId}
  jobId: string;
  agentId: string;
  conversationId?: string;
  replyToMessageId?: string;
  status: ClaudeCodeJobStatus;
  task: string;
  workingDir: string;
  sessionId?: string;
  maxTurns: number;
  result?: string;
  error?: string;
  pendingQuestion?: {
    text: string;
    options: Array<{ label: string; description: string }>;
  };
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  ttl: number;
}

/**
 * DynamoDB record for pending response
 */
export interface ClaudeCodeResponseRecord {
  pk: string; // AGENT#{agentId}
  sk: string; // CLAUDE_CODE_RESPONSE#{jobId}
  response: string;
  timestamp: number;
  ttl: number;
}
