/**
 * Media Queue Service
 *
 * Utility for enqueueing media generation jobs to MEDIA_QUEUE.
 * Similar to post-queue.ts but for image/video generation.
 */
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { SwarmResponse } from '../types/index.js';
import { randomUUID } from 'node:crypto';

let sqsClient: SQSClient | null = null;

function getSQSClient(): SQSClient {
  if (!sqsClient) {
    sqsClient = new SQSClient({});
  }
  return sqsClient;
}

/**
 * Media queue message format expected by media-processor
 */
export interface MediaQueueMessage {
  jobId: string;
  avatarId: string;
  traceId?: string;
  conversationId: string;
  action: {
    type: 'generate_image' | 'take_selfie' | 'generate_video';
    prompt: string;
    aspectRatio?: string;
    referenceImageUrls?: string[];
    style?: string;
  };
  response: SwarmResponse;
}

/**
 * Enqueue an image generation job to MEDIA_QUEUE
 */
export async function enqueueMediaJob(
  queueUrl: string,
  params: {
    avatarId: string;
    conversationId: string;
    platform: string;
    replyToMessageId?: string;
    prompt: string;
    aspectRatio?: string;
    referenceImageUrls?: string[];
    traceId?: string;
  }
): Promise<{ jobId: string }> {
  const jobId = randomUUID();
  const client = getSQSClient();

  const message: MediaQueueMessage = {
    jobId,
    avatarId: params.avatarId,
    traceId: params.traceId,
    conversationId: params.conversationId,
    action: {
      type: 'generate_image',
      prompt: params.prompt,
      aspectRatio: params.aspectRatio,
      referenceImageUrls: params.referenceImageUrls,
    },
    response: {
      avatarId: params.avatarId,
      platform: params.platform as 'telegram' | 'discord' | 'twitter' | 'web' | 'shared-chat',
      conversationId: params.conversationId,
      replyToMessageId: params.replyToMessageId,
      actions: [], // Will be filled by media-processor
      generatedAt: Date.now(),
      llmModel: 'media-queue',
      tokensUsed: 0,
    },
  };

  await client.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(message),
    MessageGroupId: params.conversationId,
    MessageDeduplicationId: `media_${jobId}`,
    MessageAttributes: params.traceId
      ? { traceId: { DataType: 'String', StringValue: params.traceId } }
      : undefined,
  }));

  return { jobId };
}

/**
 * Check if MEDIA_QUEUE is configured
 */
export function isMediaQueueConfigured(): boolean {
  return Boolean(process.env.MEDIA_QUEUE_URL);
}

/**
 * Get MEDIA_QUEUE URL from environment
 */
export function getMediaQueueUrl(): string | undefined {
  return process.env.MEDIA_QUEUE_URL || undefined;
}
