import { describe, it, expect, vi } from 'vitest';
import { DynamoDBStateService } from './index.js';

// Regression: DynamoDB Scan/Query returns at most 1MB per call.
// listAvatars() must paginate to avoid scheduled pollers missing avatars.

describe('DynamoDBStateService.listAvatars', () => {
  it('paginates GSI Query results', async () => {
    // listAvatars now uses GSI query first (gsi1pk=CONFIG, gsi1sk=avatarId)
    const send = vi.fn((command: any) => {
      // First page of GSI query
      if (!command.input?.ExclusiveStartKey) {
        return Promise.resolve({
          Items: [
            { gsi1sk: 'agent-a' },
            { gsi1sk: 'agent-b' },
          ],
          LastEvaluatedKey: { gsi1pk: 'CONFIG', gsi1sk: 'agent-b' },
        });
      }

      // Second page of GSI query
      return Promise.resolve({
        Items: [{ gsi1sk: 'agent-c' }],
        LastEvaluatedKey: undefined,
      });
    });

    const docClient = { send } as any;
    const service = new DynamoDBStateService('test-table', docClient);

    const avatars = await service.listAvatars();

    expect(avatars).toEqual(['agent-a', 'agent-b', 'agent-c']);
    expect(send).toHaveBeenCalledTimes(2);

    const firstCall = send.mock.calls[0][0] as any;
    expect(firstCall.input.TableName).toBe('test-table');
    expect(firstCall.input.IndexName).toBe('gsi1');
    expect(firstCall.input.ExclusiveStartKey).toBeUndefined();

    const secondCall = send.mock.calls[1][0] as any;
    expect(secondCall.input.ExclusiveStartKey).toEqual({ gsi1pk: 'CONFIG', gsi1sk: 'agent-b' });
  });

  it('falls back to Scan when GSI returns no results', async () => {
    // Simulate GSI returning no results, then scan finds avatars
    const send = vi.fn((command: any) => {
      
      // GSI query returns empty
      if (command.input?.IndexName === 'gsi1') {
        return Promise.resolve({ Items: [], LastEvaluatedKey: undefined });
      }

      // Scan fallback - first page
      if (!command.input?.ExclusiveStartKey) {
        return Promise.resolve({
          Items: [
            { pk: 'AVATAR#agent-a' },
            { pk: 'AVATAR#agent-b' },
          ],
          LastEvaluatedKey: { pk: 'AVATAR#agent-b', sk: 'CONFIG' },
        });
      }

      // Scan fallback - second page
      return Promise.resolve({
        Items: [{ pk: 'AVATAR#agent-c' }],
        LastEvaluatedKey: undefined,
      });
    });

    const docClient = { send } as any;
    const service = new DynamoDBStateService('test-table', docClient);

    const avatars = await service.listAvatars();

    expect(avatars).toEqual(['agent-a', 'agent-b', 'agent-c']);
    // 1 GSI query (empty) + 2 scan calls
    expect(send).toHaveBeenCalledTimes(3);
  });
});
