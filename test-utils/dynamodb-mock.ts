import { vi } from 'vitest';

type DynamoDbMockState = {
  send: ReturnType<typeof vi.fn>;
};

const GLOBAL_STATE_KEY = '__dynamoDbMockState__';

const getState = (): DynamoDbMockState => {
  const globalState = globalThis as Record<string, DynamoDbMockState | undefined>;
  if (!globalState[GLOBAL_STATE_KEY]) {
    globalState[GLOBAL_STATE_KEY] = { send: vi.fn() };
  }
  return globalState[GLOBAL_STATE_KEY]!;
};

const createCommand = () =>
  vi.fn(function (this: { input?: unknown }, input: unknown) {
    this.input = input;
  });

export const mockDynamoSend = getState().send;

vi.mock('@aws-sdk/lib-dynamodb', () => {
  const state = getState();
  return {
    DynamoDBDocumentClient: {
      from: vi.fn(() => state),
    },
    GetCommand: createCommand(),
    PutCommand: createCommand(),
    UpdateCommand: createCommand(),
    DeleteCommand: createCommand(),
    QueryCommand: createCommand(),
    ScanCommand: createCommand(),
  };
});
