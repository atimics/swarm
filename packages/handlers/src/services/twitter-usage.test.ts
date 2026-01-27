import { describe, expect, it, vi } from 'vitest';
import { TwitterUsageService } from './twitter-usage.js';

function createService(send: (command: unknown) => Promise<any>) {
  return new TwitterUsageService(
    'STATE_TABLE',
    {
      tier: 'basic',
      monthlyBudget: 15000,
      dailyReservePct: 20,
    },
    // Minimal docClient surface needed by the service.
    ({ send } as any)
  );
}

describe('TwitterUsageService (rate limit + poll attempt)', () => {
  it('getGlobalUsage returns defaults when no record exists', async () => {
    const send = vi.fn().mockResolvedValueOnce({ Item: undefined });

    const service = createService(send);
    const usage = await service.getGlobalUsage();

    expect(usage.usedToday).toBe(0);
    expect(usage.usedThisMonth).toBe(0);
    expect(usage.lastPollAt).toBe(0);
    expect(usage.consecutive429s).toBe(0);
    expect(usage.backoffUntil).toBeUndefined();
  });

  it('recordPollAttempt updates lastPollAt', async () => {
    const send = vi.fn().mockResolvedValueOnce({});

    const service = createService(send);
    await service.recordPollAttempt();

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0] as any;
    expect(command?.input?.TableName).toBe('STATE_TABLE');
    expect(String(command?.input?.UpdateExpression)).toContain('lastPollAt');
    expect(command?.input?.ExpressionAttributeValues?.[':now']).toEqual(expect.any(Number));
  });

  it('recordRateLimited sets a backoff window and increments consecutive429s', async () => {
    // First UpdateCommand returns the incremented counter.
    const send = vi.fn()
      .mockResolvedValueOnce({ Attributes: { consecutive429s: 1 } })
    // Second UpdateCommand applies backoffUntil.
      .mockResolvedValueOnce({});

    const service = createService(send);
    const before = Date.now();
    const { backoffUntil, consecutive429s } = await service.recordRateLimited();
    const after = Date.now();

    expect(consecutive429s).toBe(1);
    expect(backoffUntil).toBeGreaterThanOrEqual(before + 15 * 60 * 1000);
    expect(backoffUntil).toBeLessThanOrEqual(after + 15 * 60 * 1000);

    expect(send).toHaveBeenCalledTimes(2);
    const backoffCommand = send.mock.calls[1]?.[0] as any;
    expect(backoffCommand?.input?.ExpressionAttributeValues?.[':backoffUntil']).toBe(backoffUntil);
  });
});
