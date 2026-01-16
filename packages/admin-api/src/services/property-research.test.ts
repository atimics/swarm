/**
 * Property Research Service Tests
 * Tests property research with dependency injection
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
  checkAuth,
  grantAuth,
  createJob,
  getJobsForAgent,
  updateJobStatus,
  type PropertyResearchDeps,
} from './property-research.js';

// Helper to create mock deps
function createMockDeps(): PropertyResearchDeps & { mockSend: ReturnType<typeof mock> } {
  const mockSend = mock(() => Promise.resolve({}));

  return {
    dynamoClient: {
      send: mockSend as unknown as PropertyResearchDeps['dynamoClient']['send'],
    },
    tableName: 'test-admin-table',
    generateId: () => 'test-job-id',
    mockSend,
  };
}

describe('PropertyResearchService', () => {
  let mockDeps: PropertyResearchDeps & { mockSend: ReturnType<typeof mock> };
  const avatarId = 'test-avatar';
  const walletAddress = '0x123';

  beforeEach(() => {
    mockDeps = createMockDeps();
  });

  describe('Authorization', () => {
    it('returns true if valid auth exists', async () => {
      mockDeps.mockSend.mockImplementation(() =>
        Promise.resolve({
          Item: {
            expiresAt: Date.now() + 10000,
          },
        })
      );

      const result = await checkAuth(avatarId, walletAddress, mockDeps);
      expect(result).toBe(true);
    });

    it('returns false if auth is expired', async () => {
      mockDeps.mockSend.mockImplementation(() =>
        Promise.resolve({
          Item: {
            expiresAt: Date.now() - 10000,
          },
        })
      );

      const result = await checkAuth(avatarId, walletAddress, mockDeps);
      expect(result).toBe(false);
    });

    it('returns false if no auth exists', async () => {
      mockDeps.mockSend.mockImplementation(() =>
        Promise.resolve({ Item: undefined })
      );

      const result = await checkAuth(avatarId, walletAddress, mockDeps);
      expect(result).toBe(false);
    });

    it('returns false for empty wallet address', async () => {
      const result = await checkAuth(avatarId, '', mockDeps);
      expect(result).toBe(false);
    });

    it('grants authorization with correct TTL', async () => {
      const auth = await grantAuth(avatarId, walletAddress, mockDeps);

      expect(auth.avatarId).toBe(avatarId);
      expect(auth.walletAddress).toBe(walletAddress);
      expect(auth.expiresAt).toBeGreaterThan(Date.now());
      expect(mockDeps.mockSend).toHaveBeenCalled();
    });
  });

  describe('Job Management', () => {
    it('creates a job in queued status', async () => {
      const property = {
        address: '123 Main St',
        city: 'Victoria',
        state: 'BC',
        zip: 'V8Z 1Y8',
      };

      const job = await createJob(avatarId, property, undefined, mockDeps);

      expect(job.status).toBe('queued');
      expect(job.property.address).toBe(property.address);
      expect(job.progress.listings).toBe('pending');
      expect(job.jobId).toBe('test-job-id');
      expect(mockDeps.mockSend).toHaveBeenCalled();
    });

    it('lists job summaries for an avatar', async () => {
      mockDeps.mockSend.mockImplementation(() =>
        Promise.resolve({
          Items: [
            { jobId: 'job-1', status: 'completed', createdAt: 1000, avatarId, property: { address: 'A' } },
            { jobId: 'job-2', status: 'queued', createdAt: 2000, avatarId, property: { address: 'B' } },
          ],
        })
      );

      const jobs = await getJobsForAgent(avatarId, undefined, mockDeps);

      expect(jobs).toHaveLength(2);
      expect(jobs[0].jobId).toBe('job-2'); // Sorted by createdAt desc
      expect(jobs[1].jobId).toBe('job-1');
    });

    it('updates job status and progress', async () => {
      let callCount = 0;
      mockDeps.mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // getJob
          return Promise.resolve({
            Item: { jobId: 'job-1', createdAt: 1000, status: 'queued' },
          });
        }
        // UpdateCommand
        return Promise.resolve({});
      });

      await updateJobStatus(
        'job-1',
        'researching',
        {
          progress: {
            listings: 'in_progress',
            assessor: 'pending',
            comparables: 'pending',
            demographics: 'pending',
            schools: 'pending',
            walkability: 'pending',
          },
        },
        mockDeps
      );

      expect(mockDeps.mockSend).toHaveBeenCalledTimes(2);
      const calls = mockDeps.mockSend.mock.calls;
      const updateCall = calls[1][0] as { input?: { UpdateExpression?: string; ExpressionAttributeValues?: Record<string, unknown> } };
      const input = updateCall.input || (updateCall as unknown as { UpdateExpression?: string; ExpressionAttributeValues?: Record<string, unknown> });
      expect(input.UpdateExpression).toContain('#status = :status');
      expect(input.ExpressionAttributeValues?.[':status']).toBe('researching');
    });
  });
});
