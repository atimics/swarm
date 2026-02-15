import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DynamoDBStateService } from './state.js';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

describe('DynamoDBStateService Integration', () => {
  let service: DynamoDBStateService;
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSend = vi.fn((command: any) => {
      // Handle UpdateCommand
      if (command.input?.UpdateExpression) {
        return Promise.resolve({
          Attributes: {
            avatarId: 'a1',
            channelId: 'c1',
            platform: 'telegram',
            recentMessages: [],
            state: 'IDLE'
          }
        });
      }
      // Handle GetCommand
      if (command.input?.Key && !command.input?.UpdateExpression) {
        return Promise.resolve({
          Item: { avatarId: 'a1', channelId: 'c1', platform: 'telegram' }
        });
      }
      return Promise.resolve({});
    });

    const mockDocClient = { send: mockSend } as unknown as DynamoDBDocumentClient;
    service = new DynamoDBStateService('test-table', mockDocClient);
  });

  it('should call GetCommand for getChannelState', async () => {
    await service.getChannelState('a1', 'c1');

    expect(mockSend).toHaveBeenCalled();
    const call = mockSend.mock.calls[0][0] as any;
    expect(call.input.TableName).toBe('test-table');
    expect(call.input.Key).toEqual({ pk: 'AVATAR#a1', sk: 'CHANNEL#c1#STATE' });
  });

  it('should call UpdateCommand for addMessageToChannel', async () => {
    await service.addMessageToChannel('a1', 'c1', 'telegram', {
      sender: 'u1',
      content: 'test',
      timestamp: 123,
      messageId: 'm1',
      isBot: false
    });

    expect(mockSend).toHaveBeenCalled();
    const updateCall = mockSend.mock.calls[0][0] as any;
    expect(updateCall.input.TableName).toBe('test-table');
    expect(updateCall.input.UpdateExpression).toContain('recentMessages = list_append');
  });
});
