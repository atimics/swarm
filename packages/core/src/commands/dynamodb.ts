/**
 * Local DynamoDB command classes — drop-in replacements for @aws-sdk/lib-dynamodb.
 */
export class GetCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class PutCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class QueryCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class DeleteCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class UpdateCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class ScanCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class BatchWriteCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class TransactWriteCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}
export class TransactWriteItemsCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) { this.input = input; }
}

/** Stub class for DynamoDBDocumentClient — satisfies type annotations. */
export class DynamoDBDocumentClient {
  static from(_client: unknown, _options?: unknown): DynamoDBDocumentClient {
    return new DynamoDBDocumentClient();
  }
  async send(_command: unknown): Promise<unknown> {
    throw new Error('DynamoDBDocumentClient stub: inject a real client via _setDynamoClient()');
  }
}
