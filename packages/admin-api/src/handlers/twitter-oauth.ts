/**
 * Twitter OAuth Handler
 * Handles the OAuth 1.0a 3-legged flow for connecting X/Twitter accounts
 *
 * Routes:
 * - GET /oauth/twitter/start?avatarId=xxx - Start OAuth flow
 * - GET /oauth/twitter/callback?oauth_token=xxx&oauth_verifier=xxx - OAuth callback
 * - GET /oauth/twitter/status/{avatarId} - Check connection status
 * - DELETE /oauth/twitter/{avatarId} - Disconnect Twitter
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { authenticateRequest, requireAdmin } from '../auth/cloudflare-access.js';
import {
  isConfigured as twitterIsConfigured,
  startOAuthFlow as twitterStartOAuthFlow,
  completeOAuthFlow as twitterCompleteOAuthFlow,
  getConnectionStatus as twitterGetConnectionStatus,
  disconnectTwitter as twitterDisconnectTwitter,
} from '../services/twitter-oauth.js';
import {
  getAvatar as avataretAgent,
  updateAvatar as avatarpdateAgent,
} from '../services/avatars.js';
import type { UserSession, AvatarRecord } from '../types.js';
import { getCorsHeaders } from '../http/cors.js';

/**
 * Dependencies interface for dependency injection (testing)
 */
export interface TwitterOAuthHandlerDeps {
  twitterOAuth: {
    isConfigured: () => Promise<boolean>;
    startOAuthFlow: (avatarId: string) => Promise<{ authorizationUrl: string; oauthToken: string }>;
    completeOAuthFlow: (oauthToken: string, oauthVerifier: string, session: UserSession) => Promise<{
      success: boolean;
      avatarId: string;
      username?: string;
      userId?: string;
      error?: string;
    }>;
    getConnectionStatus: (avatarId: string) => Promise<{
      connected: boolean;
      username?: string;
      userId?: string;
      connectedAt?: number;
    }>;
    disconnectTwitter: (avatarId: string, session: UserSession) => Promise<void>;
  };
  avatarService: {
    getAvatar: (avatarId: string) => Promise<AvatarRecord | null>;
    updateAvatar: (avatarId: string, updates: Partial<AvatarRecord>, session: UserSession) => Promise<AvatarRecord>;
  };
  auth: {
    authenticateRequest: (event: APIGatewayProxyEventV2) => Promise<UserSession>;
    requireAdmin: (session: UserSession) => boolean;
  };
}

// Create default dependencies lazily to avoid issues with namespace imports at module load time
function getDefaultDeps(): TwitterOAuthHandlerDeps {
  return {
    twitterOAuth: {
      isConfigured: twitterIsConfigured,
      startOAuthFlow: twitterStartOAuthFlow,
      completeOAuthFlow: twitterCompleteOAuthFlow,
      getConnectionStatus: twitterGetConnectionStatus,
      disconnectTwitter: twitterDisconnectTwitter,
    },
    avatarService: {
      getAvatar: avataretAgent,
      updateAvatar: avatarpdateAgent,
    },
    auth: {
      authenticateRequest,
      requireAdmin,
    },
  };
}

const ADMIN_UI_URL = process.env.ADMIN_UI_URL || process.env.ALLOWED_ORIGINS?.split(',')[0] || 'http://localhost:5173';

/**
 * Lambda handler for Twitter OAuth endpoints
 * @param event - API Gateway event
 * @param depsOrContext - Optional dependencies for testing (Lambda context is passed but ignored)
 */
export async function handler(
  event: APIGatewayProxyEventV2,
  depsOrContext?: TwitterOAuthHandlerDeps | unknown
): Promise<APIGatewayProxyStructuredResultV2> {
  // Check if deps has the expected shape (not Lambda context)
  // Lambda context has properties like functionName, awsRequestId, etc.
  const deps = depsOrContext && 'twitterOAuth' in (depsOrContext as object)
    ? (depsOrContext as TwitterOAuthHandlerDeps)
    : undefined;
  const resolvedDeps = deps || getDefaultDeps();
  const { twitterOAuth, avatarService, auth } = resolvedDeps;

  const corsHeaders = getCorsHeaders(event);

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  const method = event.requestContext.http.method;
  const path = event.rawPath;

  console.log(JSON.stringify({
    level: 'INFO',
    subsystem: 'twitter-oauth',
    event: 'request_received',
    method,
    path,
    query: event.queryStringParameters,
  }));

  try {
    // GET /oauth/twitter/callback?oauth_token=xxx&oauth_verifier=xxx - OAuth callback
    // This must not require Cloudflare Access (Twitter won't provide the header).
    if (method === 'GET' && path === '/oauth/twitter/callback') {
      const result = await handleCallback(event, resolvedDeps);
      return {
        ...result,
        headers: { ...corsHeaders, ...(result.headers || {}) },
      };
    }

    // GET /oauth/twitter/start?avatarId=xxx - Start OAuth flow (no auth needed)
    // This redirects to Twitter; the callback will store tokens for the specified avatarId.
    if (method === 'GET' && path === '/oauth/twitter/start') {
      const avatarId = event.queryStringParameters?.avatarId;

      if (!avatarId) {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'avatarId query parameter is required' }),
        };
      }

      const avatar = await avatarService.getAvatar(avatarId);
      if (!avatar) {
        return {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Avatar not found' }),
        };
      }

      if (!(await twitterOAuth.isConfigured())) {
        return {
          statusCode: 503,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'Twitter OAuth not configured',
            message: 'Ensure swarm/global/twitter-app-credentials secret exists and TWITTER_OAUTH_CALLBACK_URL is set',
          }),
        };
      }

      const { authorizationUrl } = await twitterOAuth.startOAuthFlow(avatarId);

      return {
        statusCode: 302,
        headers: {
          ...corsHeaders,
          Location: authorizationUrl,
        },
        body: '',
      };
    }

    // Routes below require authentication
    const session = await auth.authenticateRequest(event);
    if (!auth.requireAdmin(session)) {
      return {
        statusCode: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Admin access required' }),
      };
    }

    // GET /oauth/twitter/status/{avatarId} - Get connection status
    const statusMatch = path.match(/^\/oauth\/twitter\/status\/([^/]+)$/);
    if (method === 'GET' && statusMatch) {
      const avatarId = statusMatch[1];
      const status = await twitterOAuth.getConnectionStatus(avatarId);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(status),
      };
    }

    // DELETE /oauth/twitter/{avatarId} - Disconnect Twitter
    const disconnectMatch = path.match(/^\/oauth\/twitter\/([^/]+)$/);
    if (method === 'DELETE' && disconnectMatch) {
      const avatarId = disconnectMatch[1];

      await twitterOAuth.disconnectTwitter(avatarId, session);

      // Update avatar config to disable Twitter
      await avatarService.updateAvatar(avatarId, {
        platforms: {
          twitter: {
            enabled: false,
            username: undefined,
          },
        },
      }, session);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, message: 'Twitter disconnected' }),
      };
    }

    // Unknown route
    return {
      statusCode: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Not found' }),
    };

  } catch (error) {
    console.error(JSON.stringify({
      level: 'ERROR',
      subsystem: 'twitter-oauth',
      event: 'handler_error',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }));

    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}

/**
 * Handle the OAuth callback from Twitter
 * This is called after the user authorizes on Twitter
 */
async function handleCallback(
  event: APIGatewayProxyEventV2,
  deps: TwitterOAuthHandlerDeps
): Promise<APIGatewayProxyStructuredResultV2> {
  const { twitterOAuth, avatarService } = deps;
  const { oauth_token, oauth_verifier, denied } = event.queryStringParameters || {};

  // User denied authorization
  if (denied) {
    return {
      statusCode: 302,
      headers: {
        Location: `${ADMIN_UI_URL}?twitter_error=denied`,
      },
      body: '',
    };
  }

  if (!oauth_token || !oauth_verifier) {
    return {
      statusCode: 302,
      headers: {
        Location: `${ADMIN_UI_URL}?twitter_error=missing_params`,
      },
      body: '',
    };
  }

  try {
    // Create a system session for the callback (user already authenticated with Twitter)
    const systemSession = {
      email: 'oauth-callback@system',
      userId: 'system',
      isAdmin: true,
      accessToken: 'oauth-callback',
    };

    const result = await twitterOAuth.completeOAuthFlow(
      oauth_token,
      oauth_verifier,
      systemSession
    );

    if (!result.success) {
      return {
        statusCode: 302,
        headers: {
          Location: `${ADMIN_UI_URL}?twitter_error=${encodeURIComponent(result.error || 'unknown')}`,
        },
        body: '',
      };
    }

    // Update avatar config to enable Twitter with the connected username
    await avatarService.updateAvatar(result.avatarId, {
      platforms: {
        twitter: {
          enabled: true,
          username: result.username,
        },
      },
    }, systemSession);

    // Redirect back to admin UI with success
    return {
      statusCode: 302,
      headers: {
        Location: `${ADMIN_UI_URL}/avatars/${result.avatarId}?twitter_connected=${result.username}`,
      },
      body: '',
    };

  } catch (error) {
    console.error('OAuth callback error:', error);

    return {
      statusCode: 302,
      headers: {
        Location: `${ADMIN_UI_URL}?twitter_error=${encodeURIComponent(error instanceof Error ? error.message : 'unknown')}`,
      },
      body: '',
    };
  }
}
