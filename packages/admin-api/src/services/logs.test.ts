/**
 * Logs Service Tests
 * Tests CloudWatch Logs query with dependency injection
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { queryAgentLogs, type LogsServiceDeps } from './logs.js';

// Helper to create mock deps
function createMockDeps(): LogsServiceDeps & { mockSend: ReturnType<typeof mock> } {
  const mockSend = mock(() => Promise.resolve({}));

  return {
    logsClient: {
      send: mockSend as unknown as LogsServiceDeps['logsClient']['send'],
    },
    logGroupPrefix: '/aws/lambda/',
    adminLogGroups: [],
    adminLogGroupPrefixes: [],
    mockSend,
  };
}

describe('logsService', () => {
  let mockDeps: LogsServiceDeps & { mockSend: ReturnType<typeof mock> };
  const agentId = 'test-agent';

  beforeEach(() => {
    mockDeps = createMockDeps();
  });

  it('queries CloudWatch Insights with correct limits and filters', async () => {
    let callCount = 0;
    mockDeps.mockSend.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // DescribeLogGroups
        return Promise.resolve({
          logGroups: [{ logGroupName: '/aws/lambda/test-agent-webhook' }],
        });
      }
      if (callCount === 2) {
        // StartQuery
        return Promise.resolve({ queryId: 'test-query-id' });
      }
      // GetQueryResults
      return Promise.resolve({
        status: 'Complete',
        results: [
          [
            { field: '@timestamp', value: '2026-01-12T10:00:00Z' },
            { field: '@message', value: '{"level":"INFO","agentId":"test-agent","message":"hello"}' },
            { field: '@log', value: '/aws/lambda/test-agent-webhook' },
          ],
        ],
      });
    });

    const result = await queryAgentLogs(agentId, { level: 'INFO', limit: 10 }, mockDeps);

    expect(result.agentId).toBe(agentId);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].message).toContain('hello');
    expect(result.filters.limit).toBe(10);
    expect(result.filters.level).toBe('INFO');

    // Verify StartQuery was called with correct arguments
    const calls = mockDeps.mockSend.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const startQueryCall = calls[1][0] as { input?: { queryString?: string; logGroupNames?: string[] } };
    const queryInput = startQueryCall.input || (startQueryCall as unknown as { queryString?: string; logGroupNames?: string[] });
    expect(queryInput.logGroupNames).toContain('/aws/lambda/test-agent-webhook');
    expect(queryInput.queryString).toContain('limit 10');
  });

  it('enforces and caps the limit at 500', async () => {
    let callCount = 0;
    mockDeps.mockSend.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
      if (callCount === 2) return Promise.resolve({ queryId: 'q1' });
      return Promise.resolve({ status: 'Complete', results: [] });
    });

    const result = await queryAgentLogs(agentId, { limit: 1000 }, mockDeps);

    expect(result.filters.limit).toBe(500);
    const calls = mockDeps.mockSend.mock.calls;
    const startQueryCall = calls[1][0] as { input?: { queryString?: string } };
    const queryInput = startQueryCall.input || (startQueryCall as unknown as { queryString?: string });
    expect(queryInput.queryString).toContain('limit 500');
  });

  it('supports time-range filters', async () => {
    const startTime = Date.now() - 1000000;
    const endTime = Date.now() - 500000;

    let callCount = 0;
    mockDeps.mockSend.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
      if (callCount === 2) return Promise.resolve({ queryId: 'q1' });
      return Promise.resolve({ status: 'Complete', results: [] });
    });

    await queryAgentLogs(agentId, { startTime, endTime }, mockDeps);

    const calls = mockDeps.mockSend.mock.calls;
    const startQueryCall = calls[1][0] as { input?: { startTime?: number; endTime?: number } };
    const queryInput = startQueryCall.input || (startQueryCall as unknown as { startTime?: number; endTime?: number });
    expect(queryInput.startTime).toBe(Math.floor(startTime / 1000));
    expect(queryInput.endTime).toBe(Math.floor(endTime / 1000));
  });

  describe('level/subsystem filters', () => {
    it('filters logs by level correctly', async () => {
      let callCount = 0;
      mockDeps.mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
        if (callCount === 2) return Promise.resolve({ queryId: 'q1' });
        return Promise.resolve({ status: 'Complete', results: [] });
      });

      await queryAgentLogs(agentId, { level: 'error' }, mockDeps);

      const calls = mockDeps.mockSend.mock.calls;
      const startQueryCall = calls[1][0] as { input?: { queryString?: string } };
      const queryInput = startQueryCall.input || (startQueryCall as unknown as { queryString?: string });
      expect(queryInput.queryString).toContain('"level"');
      expect(queryInput.queryString).toMatch(/ERROR|error/);
    });

    it('filters logs by subsystem correctly', async () => {
      let callCount = 0;
      mockDeps.mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
        if (callCount === 2) return Promise.resolve({ queryId: 'q1' });
        return Promise.resolve({ status: 'Complete', results: [] });
      });

      await queryAgentLogs(agentId, { subsystem: 'chat' }, mockDeps);

      const calls = mockDeps.mockSend.mock.calls;
      const startQueryCall = calls[1][0] as { input?: { queryString?: string } };
      const queryInput = startQueryCall.input || (startQueryCall as unknown as { queryString?: string });
      expect(queryInput.queryString).toContain('chat');
    });

    it('combines level and subsystem filters', async () => {
      let callCount = 0;
      mockDeps.mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
        if (callCount === 2) return Promise.resolve({ queryId: 'q1' });
        return Promise.resolve({ status: 'Complete', results: [] });
      });

      const result = await queryAgentLogs(agentId, { level: 'warn', subsystem: 'telegram' }, mockDeps);

      expect(result.filters.level).toBe('warn');
      expect(result.filters.subsystem).toBe('telegram');

      const calls = mockDeps.mockSend.mock.calls;
      const startQueryCall = calls[1][0] as { input?: { queryString?: string } };
      const queryInput = startQueryCall.input || (startQueryCall as unknown as { queryString?: string });
      expect(queryInput.queryString).toContain(' and ');
    });
  });

  describe('limit enforcement', () => {
    it('uses default limit of 200 when not specified', async () => {
      let callCount = 0;
      mockDeps.mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
        if (callCount === 2) return Promise.resolve({ queryId: 'q1' });
        return Promise.resolve({ status: 'Complete', results: [] });
      });

      const result = await queryAgentLogs(agentId, {}, mockDeps);

      expect(result.filters.limit).toBe(200);
    });

    it('clamps limit to minimum of 1', async () => {
      let callCount = 0;
      mockDeps.mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
        if (callCount === 2) return Promise.resolve({ queryId: 'q1' });
        return Promise.resolve({ status: 'Complete', results: [] });
      });

      const result = await queryAgentLogs(agentId, { limit: -10 }, mockDeps);

      expect(result.filters.limit).toBe(1);
    });

    it('accepts limit within valid range', async () => {
      let callCount = 0;
      mockDeps.mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
        if (callCount === 2) return Promise.resolve({ queryId: 'q1' });
        return Promise.resolve({ status: 'Complete', results: [] });
      });

      const result = await queryAgentLogs(agentId, { limit: 100 }, mockDeps);

      expect(result.filters.limit).toBe(100);
      const calls = mockDeps.mockSend.mock.calls;
      const startQueryCall = calls[1][0] as { input?: { queryString?: string } };
      const queryInput = startQueryCall.input || (startQueryCall as unknown as { queryString?: string });
      expect(queryInput.queryString).toContain('limit 100');
    });
  });

  describe('time-range filters', () => {
    it('respects explicit startTime and endTime', async () => {
      let callCount = 0;
      mockDeps.mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
        if (callCount === 2) return Promise.resolve({ queryId: 'q1' });
        return Promise.resolve({ status: 'Complete', results: [] });
      });

      const startTime = 1700000000000;
      const endTime = 1700003600000;

      const result = await queryAgentLogs(agentId, { startTime, endTime }, mockDeps);

      expect(result.startTime).toBe(startTime);
      expect(result.endTime).toBe(endTime);
    });
  });

  describe('invalid query parameters', () => {
    it('handles NaN limit by using default', async () => {
      let callCount = 0;
      mockDeps.mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
        if (callCount === 2) return Promise.resolve({ queryId: 'q1' });
        return Promise.resolve({ status: 'Complete', results: [] });
      });

      const result = await queryAgentLogs(agentId, { limit: NaN }, mockDeps);

      expect(result.filters.limit).toBe(200);
    });

    it('handles empty log groups gracefully', async () => {
      mockDeps.mockSend.mockImplementation(() => Promise.resolve({ logGroups: [] }));

      const result = await queryAgentLogs(agentId, {}, mockDeps);

      expect(result.logGroups).toHaveLength(0);
      expect(result.events).toHaveLength(0);
    });

    it('handles query failure status', async () => {
      let callCount = 0;
      mockDeps.mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
        if (callCount === 2) return Promise.resolve({ queryId: 'q1' });
        return Promise.resolve({ status: 'Failed', results: [] });
      });

      const result = await queryAgentLogs(agentId, {}, mockDeps);

      expect(result.events).toHaveLength(0);
    });

    it('handles undefined query ID', async () => {
      let callCount = 0;
      mockDeps.mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
        return Promise.resolve({ queryId: undefined });
      });

      const result = await queryAgentLogs(agentId, {}, mockDeps);

      expect(result.events).toHaveLength(0);
    });

    it('returns result with filters even on error', async () => {
      let callCount = 0;
      mockDeps.mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
        if (callCount === 2) return Promise.resolve({ queryId: 'q1' });
        return Promise.resolve({ status: 'Cancelled', results: [] });
      });

      const result = await queryAgentLogs(agentId, { level: 'error', limit: 50 }, mockDeps);

      expect(result.filters.level).toBe('error');
      expect(result.filters.limit).toBe(50);
      expect(result.events).toHaveLength(0);
    });
  });
});
