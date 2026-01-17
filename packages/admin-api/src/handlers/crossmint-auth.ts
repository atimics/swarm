/**
 * Crossmint Authentication Handler
 * Endpoints for Crossmint email/social sign-in
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z } from 'zod';
import { verifyCrossmintAuth } from '../services/crossmint-auth.js';
import { getGateStatus } from '../services/nft-gate.js';
import { getInhabitedAvatar } from '../services/avatar-ownership.js';
import { getSetSessionCookies } from '../auth/session-cookie.js';
import { getAccountSummary, getOrCreateAccountForWallet } from '../services/accounts.js';

// ============================================================================
// Request Schemas
// ============================================================================

const CrossmintVerifySchema = z.object({
  jwt: z.string().min(1),
  userId: z.string().min(1),
  email: z.string().email().optional(),
  walletAddress: z.string().min(32).max(44).optional(), // Solana address
});

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
  const origin = event.headers.origin || event.headers.Origin || '';
  const allowedOrigins = [
    'https://admin.rati.chat',
    'https://admin-staging.rati.chat',
    'http://localhost:5173',
    'http://localhost:3000',
  ];

  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
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
    const userAgent = event.headers['user-avatar'];
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

    // Get gate status for the wallet
    const gateStatus = await getGateStatus(result.user.walletAddress);

    // Inhabitation is stored in the avatar ownership mapping; don't rely on user profile fields.
    const inhabitedAvatar = await getInhabitedAvatar(result.user.walletAddress);

    const accountId = result.session.accountId || (await getOrCreateAccountForWallet(result.user.walletAddress));
    const account = await getAccountSummary(accountId);

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
      gateStatus,
    }, cors, cookies);
  } catch (error) {
    console.error('[CrossmintAuth] Verify error:', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * Main router for /auth/crossmint/* endpoints
 */
export async function handleCrossmintAuth(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath;
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

  return jsonResponse(404, { error: 'Not found' }, cors);
}
