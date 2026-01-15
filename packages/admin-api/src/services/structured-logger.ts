/**
 * Structured Logger
 * 
 * Dual-writes logs to:
 * 1. console.log (picked up by CloudWatch Logs for long-term storage)
 * 2. DynamoDB (for instant retrieval in the UI)
 * 
 * Usage:
 *   const log = createAgentLogger('agent-id', 'telegram');
 *   log.info('chat', 'message_received', { userId: '123' });
 *   log.error('llm', 'api_error', { error: 'timeout' });
 */
import { recordLog, type LogLevel } from './agent-logs.js';

export interface StructuredLogger {
  debug(subsystem: string, event: string, data?: Record<string, unknown>): void;
  info(subsystem: string, event: string, data?: Record<string, unknown>): void;
  warn(subsystem: string, event: string, data?: Record<string, unknown>): void;
  error(subsystem: string, event: string, data?: Record<string, unknown>): void;
  /** Set request ID for correlation */
  setRequestId(requestId: string): void;
}

interface LogContext {
  agentId: string;
  platform?: string;
  requestId?: string;
}

/**
 * Create a logger instance for an agent
 */
export function createAgentLogger(
  agentId: string,
  platform?: string
): StructuredLogger {
  const context: LogContext = { agentId, platform };

  const log = (
    level: LogLevel,
    subsystem: string,
    event: string,
    data?: Record<string, unknown>
  ) => {
    const logEntry = {
      level,
      subsystem,
      event,
      agentId: context.agentId,
      platform: context.platform,
      requestId: context.requestId,
      ...data,
    };

    // 1. Write to console (CloudWatch picks this up)
    console.log(JSON.stringify(logEntry));

    // 2. Write to DynamoDB (fire and forget for speed)
    // Only store INFO and above to avoid flooding DynamoDB with debug logs
    if (level !== 'DEBUG') {
      recordLog({
        agentId: context.agentId,
        level,
        subsystem,
        event,
        message: data?.message as string || event,
        data,
        requestId: context.requestId,
        platform: context.platform,
      }).catch((err) => {
        // Don't let DynamoDB errors break the main flow
        console.error('Failed to store log in DynamoDB:', err);
      });
    }
  };

  return {
    debug: (subsystem, event, data) => log('DEBUG', subsystem, event, data),
    info: (subsystem, event, data) => log('INFO', subsystem, event, data),
    warn: (subsystem, event, data) => log('WARN', subsystem, event, data),
    error: (subsystem, event, data) => log('ERROR', subsystem, event, data),
    setRequestId: (requestId: string) => {
      context.requestId = requestId;
    },
  };
}

/**
 * Global logger for non-agent-specific logs
 */
export function createSystemLogger(component: string): StructuredLogger {
  return createAgentLogger('system', component);
}
