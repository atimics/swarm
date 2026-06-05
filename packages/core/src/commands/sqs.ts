/**
 * Local SQS command classes — drop-in replacements for @aws-sdk/client-sqs.
 */
export class SendMessageCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class ReceiveMessageCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class DeleteMessageCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class GetQueueAttributesCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}

export type SendMessageCommandInput = Record<string, unknown>;
