/**
 * LocalSQSAdapter — routes SQS commands (SendMessage, ReceiveMessage,
 * DeleteMessage, GetQueueAttributes) through the in-memory InMemoryQueue.
 *
 * In local mode, all queues live in a single shared InMemoryQueue
 * keyed by queue URL or name.
 */
import { InMemoryQueue } from './queue.js';

export class LocalSQSAdapter {
  constructor(private queue: InMemoryQueue) {}

  async send(command: {
    constructor: { name: string };
    input: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const cmdName = command.constructor.name;
    const input = command.input;

    switch (cmdName) {
      case 'SendMessageCommand': {
        const queueUrl = input.QueueUrl as string;
        const body = input.MessageBody as string;
        const queueName = queueNameFromUrl(queueUrl);
        await this.queue.send(queueName, { body, queueUrl });
        return {
          $metadata: { httpStatusCode: 200 },
          MessageId: `local-${Date.now()}`,
        };
      }

      case 'ReceiveMessageCommand': {
        const queueUrl = input.QueueUrl as string;
        const maxMessages = (input.MaxNumberOfMessages as number) ?? 1;
        const queueName = queueNameFromUrl(queueUrl);
        const msgs = await this.queue.receive(queueName, maxMessages);
        return {
          $metadata: { httpStatusCode: 200 },
          Messages: msgs.map((m) => ({
            MessageId: m.id,
            ReceiptHandle: m.receiptHandle,
            Body: typeof m.body === 'string' ? m.body : JSON.stringify(m.body),
          })),
        };
      }

      case 'DeleteMessageCommand': {
        const queueUrl = input.QueueUrl as string;
        const receiptHandle = input.ReceiptHandle as string;
        const queueName = queueNameFromUrl(queueUrl);
        await this.queue.delete(queueName, receiptHandle);
        return { $metadata: { httpStatusCode: 200 } };
      }

      case 'GetQueueAttributesCommand': {
        const queueUrl = input.QueueUrl as string;
        const queueName = queueNameFromUrl(queueUrl);
        const count = await this.queue.getApproximateCount(queueName);
        return {
          $metadata: { httpStatusCode: 200 },
          Attributes: {
            ApproximateNumberOfMessages: String(count),
            ApproximateNumberOfMessagesNotVisible: '0',
          },
        };
      }

      default:
        throw new Error(`LocalSQSAdapter: unsupported command "${cmdName}"`);
    }
  }
}

/** Extract a queue name from a URL like https://sqs.../queue-name */
function queueNameFromUrl(url: string): string {
  const parts = url.split('/');
  return parts[parts.length - 1] ?? url;
}
