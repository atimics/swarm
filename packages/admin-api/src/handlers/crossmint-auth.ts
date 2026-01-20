/**
 * Crossmint Authentication Handler
 * Endpoints for Crossmint email/social sign-in
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z } from 'zod';
import { resolveCrossmintWalletAddress, verifyCrossmintAuth, verifyCrossmintJwtForLink } from '../services/crossmint-auth.js';
import { getInhabitedAvatar } from '../services/avatar-ownership.js';
import { getClearSessionCookies, getSessionFromCookie, getSetSessionCookies } from '../auth/session-cookie.js';
import { getAccountSummary, getOrCreateAccountForWallet, linkCrossmintIdentityToAccount } from '../services/accounts.js';
import { getAccountGateStatus } from '../services/account-gate.js';
import { getSessionWithUser } from '../services/wallet-auth.js';
import { getCorsHeaders } from '../http/cors.js';

// ============================================================================
// Request Schemas
// ============================================================================

const CrossmintVerifySchema = z.object({
  jwt: z.string().min(1),
  userId: z.string().min(1),
  email: z.string().email().optional(),
  walletAddress: z.string().min(32).max(44).optional(), // Solana address
});

const CrossmintLinkVerifySchema = CrossmintVerifySchema;

// Cookie helpers live in ../auth/session-cookie.ts

// ============================================================================
// Response Helpers
// ============================================================================

function jsonResponse(
  statusCode: number,
  body: unknown,
  headers?: Record<string, string>,
  cookies?: string[]
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    cookies,
    body: JSON.stringify(body),
  };
}

function corsHeaders(event: APIGatewayProxyEventV2): Record<string, string> {
  return getCorsHeaders(event);
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /auth/crossmint/verify
 * Verify Crossmint auth token and create session
 */
export async function handleCrossmintVerify(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = corsHeaders(event);

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Parse request
    const body = JSON.parse(event.body || '{}');
    const parsed = CrossmintVerifySchema.safeParse(body);

    if (!parsed.success) {
      return jsonResponse(400, {
        error: 'Invalid request',
        details: parsed.error.issues,
      }, cors);
    }

    // Get client info
    const userAgent = event.headers['user-agent'] || event.headers['User-Agent'] || '';
    const ipAddress = event.requestContext.http.sourceIp;

    // Verify and create session
    const result = await verifyCrossmintAuth(
      parsed.data,
      userAgent,
      ipAddress
    );

    if (!result.success || !result.session || !result.user) {
      return jsonResponse(401, {
        error: result.error || 'Authentication failed',
      }, cors);
    }

    // Inhabitation is stored in the avatar ownership mapping; don't rely on user profile fields.
    const inhabitedAvatar = await getInhabitedAvatar(result.user.walletAddress);

    const accountId = result.session.accountId || (await getOrCreateAccountForWallet(result.user.walletAddress));
    const account = await getAccountSummary(accountId);

    const gate = await getAccountGateStatus(accountId);

    // Set session cookies (and clear any stale host-only cookie)
    const cookies = getSetSessionCookies(result.session.sessionToken);

    return jsonResponse(200, {
      success: true,
      session: {
        token: result.session.sessionToken,
        expiresAt: result.session.expiresAt,
      },
      account,
      user: {
        walletAddress: result.user.walletAddress,
        displayName: result.user.displayName,
        email: result.user.email,
        avatarUrl: result.user.avatarUrl,
        inhabitedAvatarId: inhabitedAvatar?.avatarId,
      },
      nftGate: result.nftGate,
      gateStatus: gate.gateStatus,
      gateWallet: gate.gateWallet,
      gateStatusByWallet: gate.gateStatusByWallet,
    }, cors, cookies);
  } catch (error) {
    console.error('[CrossmintAuth] Verify error:', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * POST /auth/link/crossmint/verify
 * Verify a Crossmint JWT and link the Crossmint identity to the current account.
 * Does NOT create a new backend session or set cookies.
 */
export async function handleLinkCrossmintVerify(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = corsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(401, { error: 'Not authenticated' }, cors, getClearSessionCookies());
    }

    const session = await getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(401, { error: 'Session expired' }, cors, getClearSessionCookies());
    }

    const body = JSON.parse(event.body || '{}');
    const parsed = CrossmintLinkVerifySchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse(400, { error: 'Invalid request', details: parsed.error.issues }, cors);
    }

    const jwtOk = await verifyCrossmintJwtForLink(parsed.data.jwt);
    if (!jwtOk) {
      return jsonResponse(401, { error: 'Invalid authentication token' }, cors);
    }

    const crossmintWallet = await resolveCrossmintWalletAddress({
      userId: parsed.data.userId,
      walletAddress: parsed.data.walletAddress,
    });

    const accountId = session.accountId || (await getOrCreateAccountForWallet(session.user.walletAddress));

    const linkResult = await linkCrossmintIdentityToAccount({
      accountId,
      crossmintUserId: parsed.data.userId,
      walletAddress: crossmintWallet ?? undefined,
    });

    if (!linkResult.success) {
      return jsonResponse(409, { error: linkResult.error, conflict: linkResult.conflict }, cors);
    }

    const account = await getAccountSummary(accountId);
    const gate = await getAccountGateStatus(accountId);

    return jsonResponse(200, {
      success: true,
      account,
      gateStatus: gate.gateStatus,
      gateWallet: gate.gateWallet,
      gateStatusByWallet: gate.gateStatusByWallet,
    }, cors);
  } catch (error) {
    console.error('[CrossmintAuth] Link verify error:', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * Main router for /auth/crossmint/* endpoints
 */
export async function handleCrossmintAuth(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const rawPath = event.rawPath;
  const path = rawPath === '/api'
    ? '/'
    : rawPath.startsWith('/api/')
      ? rawPath.slice('/api'.length)
      : rawPath;
  const method = event.requestContext.http.method;
  const cors = corsHeaders(event);

  // Handle preflight for all routes
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  // Route to appropriate handler
  if (path === '/auth/crossmint/verify' && method === 'POST') {
    return handleCrossmintVerify(event);
  }

  if (path === '/auth/link/crossmint/verify' && method === 'POST') {
    return handleLinkCrossmintVerify(event);
  }

  return jsonResponse(404, { error: 'Not found' }, cors);
}
