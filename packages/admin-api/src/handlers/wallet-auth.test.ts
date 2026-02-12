/**
 * Wallet Auth Handler Tests
 *
 * Focused unit coverage for /auth/me session reporting.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

const mockGetSessionWithUser = mock();
const mockGetGateStatus = mock();

const { handleWalletAuth } = await import('./wallet-auth.js');

const prevSessionCookieName = process.env.SESSION_COOKIE_NAME;
process.env.SESSION_COOKIE_NAME = 'swarm_session';

function createEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/auth/me',
    rawQueryString: '',
    headers: {
      origin: 'http://localhost:5173',
    },
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'GET',
        path: '/auth/me',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'request-id',
      routeKey: '$default',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 1704067200000,
    },
    isBase64Encoded: false,
    cookies: ['swarm_session=test-session-token'],
    ...overrides,
  } as APIGatewayProxyEventV2;
}

// Restore for other tests (best-effort)
process.on('exit', () => {
  if (prevSessionCookieName === undefined) {
    delete process.env.SESSION_COOKIE_NAME;
  } else {
    process.env.SESSION_COOKIE_NAME = prevSessionCookieName;
  }
});

describe('Wallet Auth Handler', () => {
  beforeEach(() => {
    mockGetSessionWithUser.mockReset();
    mockGetGateStatus.mockReset();
  });

  it('GET /auth/me returns authenticated user details', async () => {
    mockGetSessionWithUser.mockImplementation(async () => ({
      walletAddress: 'wallet-1',
      sessionToken: 'test-session-token',
      user: {
        pk: 'USER#wallet-1',
        sk: 'PROFILE',
        walletAddress: 'wallet-1',
        displayName: 'Tester',
        avatarUrl: 'https://example.com/u.png',
        createdAt: 1,
        lastSeenAt: 1,
        sessionCount: 1,
      },
    }));

    mockGetGateStatus.mockImplementation(async () => ({
      nftsHeld: 0,
      avatarsCreated: 0,
      availableSlots: 0,
      canCreate: false,
      canAbandon: false,
    }));

    const res = (await handleWalletAuth(createEvent(), {
      walletAuth: { getSessionWithUser: mockGetSessionWithUser as any },
      nftGate: { getGateStatus: mockGetGateStatus as any },
    })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string);

    expect(body.authenticated).toBe(true);
    expect(body.user.walletAddress).toBe('wallet-1');
    expect(body.user.displayName).toBe('Tester');
    expect(body.user.avatarUrl).toBe('https://example.com/u.png');
  });

  it('GET /auth/me omits optional profile fields when unavailable', async () => {
    mockGetSessionWithUser.mockImplementation(async () => ({
      walletAddress: 'wallet-1',
      sessionToken: 'test-session-token',
      user: {
        pk: 'USER#wallet-1',
        sk: 'PROFILE',
        walletAddress: 'wallet-1',
        displayName: 'Tester',
        createdAt: 1,
        lastSeenAt: 1,
        sessionCount: 1,
      },
    }));

    mockGetGateStatus.mockImplementation(async () => ({
      nftsHeld: 0,
      avatarsCreated: 0,
      availableSlots: 0,
      canCreate: false,
      canAbandon: false,
    }));

    const res = (await handleWalletAuth(createEvent(), {
      walletAuth: { getSessionWithUser: mockGetSessionWithUser as any },
      nftGate: { getGateStatus: mockGetGateStatus as any },
    })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string);

    expect(body.authenticated).toBe(true);
    expect(body.user.displayName).toBe('Tester');
    expect(body.user.avatarUrl).toBeUndefined();
  });
});
