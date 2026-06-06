/**
 * Lambda-compatible type definitions.
 *
 * Replaces the @types/aws-lambda dependency with locally-defined interfaces
 * that match the shapes actually used across admin-api and handlers.
 *
 * These types describe the AWS Lambda execution environment contract.
 * In local/dev mode, callers are Express routes that satisfy the same
 * structural contract without the npm dependency.
 *
 * Fields not used by this codebase are omitted to keep the definitions lean.
 */

// ── API Gateway (HTTP API / v2 payload format) ──────────────────────────

export interface APIGatewayProxyEventV2 {
  body?: string | null;
  headers: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  pathParameters?: Record<string, string | undefined>;
  rawPath: string;
  rawQueryString: string;
  routeKey: string;
  requestContext: {
    http: {
      method: string;
      path: string;
    };
    requestId: string;
    timeEpoch: number;
  };
  isBase64Encoded: boolean;
}

export interface APIGatewayProxyResultV2 {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

export interface APIGatewayProxyResult {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
}

export type APIGatewayProxyHandler = (
  event: APIGatewayProxyEventV2,
  context: Context,
) => Promise<APIGatewayProxyResult>;

// ── SQS ─────────────────────────────────────────────────────────────────

export interface SQSEvent {
  Records: SQSRecord[];
}

export interface SQSRecord {
  messageId: string;
  receiptHandle: string;
  body: string;
  attributes: Record<string, string>;
  messageAttributes: Record<string, SQSMessageAttribute>;
  eventSource: string;
  eventSourceARN: string;
  awsRegion: string;
}

export interface SQSMessageAttribute {
  stringValue?: string;
  binaryValue?: string;
  stringListValues?: string[];
  binaryListValues?: string[];
  dataType: string;
}

export interface SQSBatchResponse {
  batchItemFailures: Array<{ itemIdentifier: string }>;
}

// ── Lambda Context ──────────────────────────────────────────────────────

export interface Context {
  awsRequestId: string;
  functionName: string;
  functionVersion: string;
  invokedFunctionArn: string;
  memoryLimitInMB: number;
  logGroupName: string;
  logStreamName: string;
  getRemainingTimeInMillis: () => number;
}

// ── Scheduled Events (CloudWatch Events / EventBridge) ──────────────────

export interface ScheduledEvent {
  version: string;
  id: string;
  "detail-type": string;
  source: string;
  account: string;
  time: string;
  region: string;
  resources: string[];
  detail: Record<string, unknown>;
}

// ── DynamoDB Streams ────────────────────────────────────────────────────

export interface DynamoDBStreamEvent {
  Records: DynamoDBRecord[];
}

export interface DynamoDBRecord {
  eventID: string;
  eventName: "INSERT" | "MODIFY" | "REMOVE";
  eventSource: string;
  eventSourceARN: string;
  dynamodb?: {
    Keys?: Record<string, AttributeValue>;
    NewImage?: Record<string, AttributeValue>;
    OldImage?: Record<string, AttributeValue>;
    SequenceNumber?: string;
    SizeBytes?: number;
    StreamViewType?: string;
  };
}

export interface AttributeValue {
  S?: string;
  N?: string;
  B?: string;
  SS?: string[];
  NS?: string[];
  BS?: string[];
  M?: Record<string, AttributeValue>;
  L?: AttributeValue[];
  NULL?: boolean;
  BOOL?: boolean;
}

// ── Generic Handler Types ───────────────────────────────────────────────

export type Handler<TEvent = unknown, TResult = unknown> = (
  event: TEvent,
  context: Context,
) => Promise<TResult>;

export type SQSHandler = Handler<SQSEvent, SQSBatchResponse | void>;

export type ScheduledHandler = Handler<ScheduledEvent, void>;
