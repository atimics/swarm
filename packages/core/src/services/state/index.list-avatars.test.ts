import { describe, it, expect, mock } from 'bun:test';
import { DynamoDBStateService } from './index.js';

// Regression: DynamoDB Scan returns at most 1MB per call.
// listAvatars() must paginate to avoid scheduled pollers missing avatars.

describe('DynamoDBStateService.listAvatars', () => {
  it('paginates Scan results', async () => {
    const send = mock((command: any) => {
      // First page
      if (!command.input?.ExclusiveStartKey) {
        return Promise.resolve({
          Items: [
            { pk: 'AVATAR#agent-a', sk: 'CONFIG' },
            { pk: 'AVATAR#agent-b', sk: 'CONFIG' },
          ],
          LastEvaluatedKey: { pk: 'AVATAR#agent-b', sk: 'CONFIG' },
        });
      }

      // Second page
      return Promise.resolve({
        Items: [{ pk: 'AVATAR#agent-c', sk: 'CONFIG' }],
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
    expect(firstCall.input.ExclusiveStartKey).toBeUndefined();

    const secondCall = send.mock.calls[1][0] as any;
    expect(secondCall.input.ExclusiveStartKey).toEqual({ pk: 'AVATAR#agent-b', sk: 'CONFIG' });
  });
});
