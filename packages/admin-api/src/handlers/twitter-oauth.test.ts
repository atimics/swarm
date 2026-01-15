/**
 * Twitter OAuth Handler Tests
 *
 * Tests for the OAuth 1.0a handler routes using dependency injection.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler, type TwitterOAuthHandlerDeps } from './twitter-oauth.js';
import type { UserSession, AgentRecord } from '../types.js';

// Helper to create a mock API Gateway event
function createEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/oauth/twitter/start',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'GET',
        path: '/oauth/twitter/start',
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
    ...overrides,
  } as APIGatewayProxyEventV2;
}

// Helper to create test session
function createTestSession(overrides: Partial<UserSession> = {}): UserSession {
  return {
    email: 'test@example.com',
    userId: 'user-123',
    isAdmin: true,
    accessToken: 'test-access-token',
    ...overrides,
  };
}

// Helper to create a mock agent record
function createMockAgent(agentId: string): AgentRecord {
  return {
    pk: `AGENT#${agentId}`,
    sk: 'CONFIG',
    agentId,
    name: 'Test Agent',
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    createdBy: 'test@example.com',
  };
}

describe('Twitter OAuth Handler', () => {
  let mockDeps: TwitterOAuthHandlerDeps;
  let mockIsConfigured: ReturnType<typeof mock>;
  let mockStartOAuthFlow: ReturnType<typeof mock>;
  let mockCompleteOAuthFlow: ReturnType<typeof mock>;
  let mockGetConnectionStatus: ReturnType<typeof mock>;
  let mockDisconnectTwitter: ReturnType<typeof mock>;
  let mockGetAgent: ReturnType<typeof mock>;
  let mockUpdateAgent: ReturnType<typeof mock>;
  let mockAuthenticateRequest: ReturnType<typeof mock>;
  let mockRequireAdmin: ReturnType<typeof mock>;

  beforeEach(() => {
    // Create fresh mocks for each test
    mockIsConfigured = mock(() => Promise.resolve(true));
    mockStartOAuthFlow = mock(() =>
      Promise.resolve({
        authorizationUrl: 'https://twitter.com/oauth/authorize?oauth_token=test-token',
        oauthToken: 'test-token',
      })
    );
    mockCompleteOAuthFlow = mock(() =>
      Promise.resolve({
        success: true,
        agentId: 'test-agent',
        username: 'testuser',
        userId: '12345',
      })
    );
    mockGetConnectionStatus = mock(() =>
      Promise.resolve({
        connected: true,
        username: 'testuser',
        userId: '12345',
        connectedAt: Date.now(),
      })
    );
    mockDisconnectTwitter = mock(() => Promise.resolve());
    mockGetAgent = mock(() => Promise.resolve(createMockAgent('test-agent')));
    mockUpdateAgent = mock(() => Promise.resolve(createMockAgent('test-agent')));
    mockAuthenticateRequest = mock(() => Promise.resolve(createTestSession()));
    mockRequireAdmin = mock(() => true);

    mockDeps = {
      twitterOAuth: {
        isConfigured: mockIsConfigured as unknown as TwitterOAuthHandlerDeps['twitterOAuth']['isConfigured'],
        startOAuthFlow: mockStartOAuthFlow as unknown as TwitterOAuthHandlerDeps['twitterOAuth']['startOAuthFlow'],
        completeOAuthFlow: mockCompleteOAuthFlow as unknown as TwitterOAuthHandlerDeps['twitterOAuth']['completeOAuthFlow'],
        getConnectionStatus: mockGetConnectionStatus as unknown as TwitterOAuthHandlerDeps['twitterOAuth']['getConnectionStatus'],
        disconnectTwitter: mockDisconnectTwitter as unknown as TwitterOAuthHandlerDeps['twitterOAuth']['disconnectTwitter'],
      },
      agentService: {
        getAgent: mockGetAgent as unknown as TwitterOAuthHandlerDeps['agentService']['getAgent'],
        updateAgent: mockUpdateAgent as unknown as TwitterOAuthHandlerDeps['agentService']['updateAgent'],
      },
      auth: {
        authenticateRequest: mockAuthenticateRequest as unknown as TwitterOAuthHandlerDeps['auth']['authenticateRequest'],
        requireAdmin: mockRequireAdmin as unknown as TwitterOAuthHandlerDeps['auth']['requireAdmin'],
      },
    };
  });

  describe('OPTIONS - CORS preflight', () => {
    it('returns 204 for OPTIONS requests', async () => {
      const event = createEvent({
        requestContext: {
          ...createEvent().requestContext,
          http: { ...createEvent().requestContext.http, method: 'OPTIONS' },
        },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(204);
    });
  });

  describe('GET /oauth/twitter/start', () => {
    it('returns 400 when agentId is missing', async () => {
      const event = createEvent({
        rawPath: '/oauth/twitter/start',
        queryStringParameters: {},
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body as string);
      expect(body.error).toContain('agentId');
    });

    it('returns 404 when agent does not exist', async () => {
      mockGetAgent.mockImplementation(() => Promise.resolve(null));

      const event = createEvent({
        rawPath: '/oauth/twitter/start',
        queryStringParameters: { agentId: 'nonexistent' },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body as string);
      expect(body.error).toBe('Agent not found');
    });

    it('returns 503 when Twitter OAuth is not configured', async () => {
      mockIsConfigured.mockImplementation(() => Promise.resolve(false));

      const event = createEvent({
        rawPath: '/oauth/twitter/start',
        queryStringParameters: { agentId: 'test-agent' },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(503);
      const body = JSON.parse(result.body as string);
      expect(body.error).toBe('Twitter OAuth not configured');
    });

    it('returns authorization URL on success', async () => {
      const event = createEvent({
        rawPath: '/oauth/twitter/start',
        queryStringParameters: { agentId: 'test-agent' },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.authorizationUrl).toContain('twitter.com');
      expect(mockStartOAuthFlow).toHaveBeenCalledWith('test-agent');
    });
  });

  describe('GET /oauth/twitter/callback', () => {
    it('redirects with error when user denies authorization', async () => {
      const event = createEvent({
        rawPath: '/oauth/twitter/callback',
        queryStringParameters: { denied: 'true' },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(302);
      expect(result.headers?.Location).toContain('twitter_error=denied');
    });

    it('redirects with error when oauth params missing', async () => {
      const event = createEvent({
        rawPath: '/oauth/twitter/callback',
        queryStringParameters: {},
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(302);
      expect(result.headers?.Location).toContain('twitter_error=missing_params');
    });

    it('completes OAuth flow and redirects on success', async () => {
      const event = createEvent({
        rawPath: '/oauth/twitter/callback',
        queryStringParameters: {
          oauth_token: 'test-token',
          oauth_verifier: 'test-verifier',
        },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(302);
      expect(result.headers?.Location).toContain('twitter_connected=testuser');
      expect(mockCompleteOAuthFlow).toHaveBeenCalledWith(
        'test-token',
        'test-verifier',
        expect.objectContaining({ email: 'oauth-callback@system' })
      );
    });

    it('updates agent config after successful OAuth', async () => {
      const event = createEvent({
        rawPath: '/oauth/twitter/callback',
        queryStringParameters: {
          oauth_token: 'test-token',
          oauth_verifier: 'test-verifier',
        },
      });

      await handler(event, mockDeps);

      expect(mockUpdateAgent).toHaveBeenCalledWith(
        'test-agent',
        expect.objectContaining({
          platforms: {
            twitter: {
              enabled: true,
              username: 'testuser',
            },
          },
        }),
        expect.any(Object)
      );
    });

    it('redirects with error when OAuth completion fails', async () => {
      mockCompleteOAuthFlow.mockImplementation(() =>
        Promise.resolve({
          success: false,
          agentId: 'test-agent',
          error: 'Token expired',
        })
      );

      const event = createEvent({
        rawPath: '/oauth/twitter/callback',
        queryStringParameters: {
          oauth_token: 'expired-token',
          oauth_verifier: 'verifier',
        },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(302);
      expect(result.headers?.Location).toContain('twitter_error=Token');
    });
  });

  describe('GET /oauth/twitter/status/{agentId}', () => {
    it('requires authentication', async () => {
      mockRequireAdmin.mockImplementation(() => false);

      const event = createEvent({
        rawPath: '/oauth/twitter/status/test-agent',
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(403);
    });

    it('returns connection status', async () => {
      const event = createEvent({
        rawPath: '/oauth/twitter/status/test-agent',
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.connected).toBe(true);
      expect(body.username).toBe('testuser');
      expect(mockGetConnectionStatus).toHaveBeenCalledWith('test-agent');
    });

    it('returns not connected status', async () => {
      mockGetConnectionStatus.mockImplementation(() =>
        Promise.resolve({ connected: false })
      );

      const event = createEvent({
        rawPath: '/oauth/twitter/status/disconnected-agent',
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.connected).toBe(false);
    });
  });

  describe('DELETE /oauth/twitter/{agentId}', () => {
    it('requires authentication', async () => {
      mockRequireAdmin.mockImplementation(() => false);

      const event = createEvent({
        rawPath: '/oauth/twitter/test-agent',
        requestContext: {
          ...createEvent().requestContext,
          http: { ...createEvent().requestContext.http, method: 'DELETE' },
        },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(403);
    });

    it('disconnects Twitter and updates agent', async () => {
      const event = createEvent({
        rawPath: '/oauth/twitter/test-agent',
        requestContext: {
          ...createEvent().requestContext,
          http: { ...createEvent().requestContext.http, method: 'DELETE' },
        },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.success).toBe(true);
      expect(mockDisconnectTwitter).toHaveBeenCalled();
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        'test-agent',
        expect.objectContaining({
          platforms: {
            twitter: {
              enabled: false,
              username: undefined,
            },
          },
        }),
        expect.any(Object)
      );
    });
  });

  describe('Unknown routes', () => {
    it('returns 404 for unknown GET routes', async () => {
      const event = createEvent({
        rawPath: '/oauth/twitter/unknown/route',
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(404);
    });
  });

  describe('Error handling', () => {
    it('returns 500 on unexpected errors', async () => {
      mockAuthenticateRequest.mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      const event = createEvent({
        rawPath: '/oauth/twitter/status/test-agent',
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body as string);
      expect(body.error).toBe('Internal server error');
    });
  });
});
