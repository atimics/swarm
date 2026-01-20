/**
 * Chat Worker
 * Processes async admin chat jobs from SQS and writes results back to DynamoDB.
 */
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { logger } from '@swarm/core';
import * as chatHistory from '../services/chat-history.js';
import { getChatJob, updateChatJobStatus } from '../services/chat-jobs.js';
import { processChat } from './chat.js';

type ChatJobMessage = {
  jobId: string;
};

function parseRecord(record: SQSRecord): ChatJobMessage {
  const parsed = JSON.parse(record.body) as Partial<ChatJobMessage>;
  if (!parsed.jobId || typeof parsed.jobId !== 'string') {
    throw new Error('Invalid SQS message: missing jobId');
  }
  return { jobId: parsed.jobId };
}

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    try {
      const { jobId } = parseRecord(record);
      logger.setContext({ subsystem: 'chat', requestId: record.messageId });

      const job = await getChatJob(jobId);
      if (!job) {
        logger.warn('Chat job not found', { event: 'chat_job_missing', jobId });
        continue;
      }

      await updateChatJobStatus(jobId, 'processing');

      const session = {
        email: job.session.email ?? '',
        userId: job.session.userId ?? '',
        isAdmin: Boolean(job.session.isAdmin),
        accessToken: '',
      };

      const result = await processChat(
        job.request.message,
        job.request.history,
        session,
        // Use the request avatar as-is; dynamic categories are recomputed in the handler when needed.
        job.request.avatar,
        {
          customSystemPrompt: job.request.systemPrompt,
          attachments: job.request.attachments,
          model: job.request.model,
        }
      );

      await chatHistory.saveChatHistory(session, result.history, job.avatarId);

      await updateChatJobStatus(jobId, 'completed', {
        result: {
          response: result.response,
          history: result.history,
          media: result.media,
          pendingJobs: result.pendingJobs,
          pendingToolCall: result.pendingToolCall,
          avatarUpdates: result.avatarUpdates,
        },
      });

      logger.info('Chat job completed', { event: 'chat_job_completed', jobId });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Chat worker error', error, { event: 'chat_job_failed' });

      // Best-effort: if we can extract jobId, mark failed
      try {
        const maybeParsed = JSON.parse(record.body) as Partial<ChatJobMessage>;
        if (maybeParsed.jobId && typeof maybeParsed.jobId === 'string') {
          await updateChatJobStatus(maybeParsed.jobId, 'failed', { error: message });
        }
      } catch {
        // ignore
      }

      // Re-throw so SQS retry/DLQ behavior applies
      throw error;
    }
  }
}
