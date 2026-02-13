import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const getAvatarMock = mock();
const getBurnStatsWithProgressMock = mock();
const getBurnHistoryMock = mock();
const getAvatarRankMock = mock();
const getEnergyStatusMock = mock();

mock.module('../services/avatars.js', () => ({
  getAvatar: getAvatarMock,
}));

mock.module('../services/burn-stats.js', () => ({
  getBurnStatsWithProgress: getBurnStatsWithProgressMock,
  getBurnHistory: getBurnHistoryMock,
  getAvatarRank: getAvatarRankMock,
}));

mock.module('../services/energy.js', () => ({
  getEnergyStatus: getEnergyStatusMock,
}));

import { handler } from './public-profile.js';

function createEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    resource: '/api/profile/{avatarId}',
    path: '/api/profile/test-avatar',
    httpMethod: 'GET',
    headers: {},
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: { avatarId: 'test-avatar' },
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    body: null,
    isBase64Encoded: false,
    ...overrides,
  };
}

describe('public profile visibility hardening', () => {
  beforeEach(() => {
    getAvatarMock.mockReset();
    getBurnStatsWithProgressMock.mockReset();
    getBurnHistoryMock.mockReset();
    getAvatarRankMock.mockReset();
    getEnergyStatusMock.mockReset();

    getBurnStatsWithProgressMock.mockResolvedValue({
      totalBurned: 0,
      tier: 0,
      tierName: 'None',
      tierEmoji: '',
      maxEnergy: 10,
      regenPerHour: 1,
      features: [],
      burnCount: 0,
      lastBurnAt: undefined,
      nextTier: null,
      nextTierAt: null,
      progressPercent: 0,
    });
    getBurnHistoryMock.mockResolvedValue([]);
    getAvatarRankMock.mockResolvedValue({ rank: null, totalAvatars: null });
    getEnergyStatusMock.mockResolvedValue({
      current: 10,
      max: 10,
      refillPerHour: 1,
      nextRefillIn: 0,
    });
  });

  it('returns 404 for non-active avatars', async () => {
    getAvatarMock.mockResolvedValue({
      avatarId: 'test-avatar',
      name: 'Test',
      status: 'draft',
    });

    const result = await handler(createEvent(), {} as never, () => {});
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(404);
    expect(body.error).toBe('Avatar not found');
    expect(getBurnStatsWithProgressMock).not.toHaveBeenCalled();
  });

  it('returns 404 for deleted avatars', async () => {
    getAvatarMock.mockResolvedValue({
      avatarId: 'test-avatar',
      name: 'Test',
      status: 'deleted',
    });

    const result = await handler(createEvent(), {} as never, () => {});
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(404);
    expect(body.error).toBe('Avatar not found');
    expect(getBurnStatsWithProgressMock).not.toHaveBeenCalled();
  });

  it('does not leak persona text via description fallback', async () => {
    getAvatarMock.mockResolvedValue({
      avatarId: 'test-avatar',
      name: 'Test',
      status: 'active',
      persona: 'internal system prompt content',
      platforms: {},
    });

    const result = await handler(createEvent(), {} as never, () => {});
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.description).toBeUndefined();
  });
});
