/**
 * Wallet Authentication Handler
 * Endpoints for Solana wallet sign-in (SIWS)
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z } from 'zod';
import {
  createChallenge,
  verifyAndCreateSession,
  getSessionWithUser,
  deleteSession,
} from '../services/wallet-auth.js';
import { getAccountSummary, getOrCreateAccountForWallet } from '../services/accounts.js';
import { createLinkWalletChallenge, verifyLinkWallet } from '../services/wallet-link.js';
import { getAccountGateStatus } from '../services/account-gate.js';
import {
  getClearSessionCookies,
  getSessionFromCookie,
  getSetSessionCookies,
} from '../auth/session-cookie.js';
import { getCorsHeaders } from '../http/cors.js';
import {
  inhabitAvatar,
  abandonAvatar,
  canAbandon,
  getInhabitationInfo,
  getInhabitedAvatar,
} from '../services/avatar-ownership.js';
import { getGateStatus } from '../services/nft-gate.js';
import { listUnclaimedAvatars } from '../services/avatars.js';
import { prepareLineageMint } from '../services/lineage-nft.js';
import { recordBurn } from '../services/burn-stats.js';
import { handleCrossmintAuth } from './crossmint-auth.js';
import { handlePrivyAuth } from './privy-auth.js';
import {
  preflightAscend,
  verifyAscensionBurns,
  executeAscension,
  getAvatarAscensionStatus,
} from '../services/avatar-ascend.js';

// Internal test key for E2E tests - bypasses NFT gate requirements
// NEVER active in production
const INTERNAL_TEST_KEY = process.env.INTERNAL_TEST_KEY;
const IS_PROD = (() => {
  const env = process.env.ENVIRONMENT || '';
  return env === 'prod' || env === 'production';
})();

/**
 * Check if request has valid internal test key.
 * Always returns false in production.
 */
function hasInternalTestKey(event: APIGatewayProxyEventV2): boolean {
  if (IS_PROD || !INTERNAL_TEST_KEY) return false;
  const providedKey = event.headers['x-internal-test-key'];
  return providedKey === INTERNAL_TEST_KEY;
}

export interface WalletAuthHandlerDeps {
  walletAuth: {
    getSessionWithUser: typeof getSessionWithUser;
  };
  avatarOwnership: {
    getInhabitedAvatar: typeof getInhabitedAvatar;
  };
  nftGate: {
    getGateStatus: typeof getGateStatus;
  };
  accountGate?: {
    getAccountGateStatus: typeof getAccountGateStatus;
  };
  accounts?: {
    getOrCreateAccountForWallet: typeof getOrCreateAccountForWallet;
    getAccountSummary: typeof getAccountSummary;
  };
}

function getDefaultDeps(): WalletAuthHandlerDeps {
  return {
    walletAuth: {
      getSessionWithUser,
    },
    avatarOwnership: {
      getInhabitedAvatar,
    },
    nftGate: {
      getGateStatus,
    },
    accountGate: {
      getAccountGateStatus,
    },
    accounts: {
      getOrCreateAccountForWallet,
      getAccountSummary,
    },
  };
}

// ============================================================================
// Request Schemas
// ============================================================================

const ChallengeRequestSchema = z.object({
  walletAddress: z.string().min(32).max(44), // Solana addresses are 32-44 chars base58
});

const VerifyRequestSchema = z.object({
  signature: z.string().min(64), // Base58 signature
  publicKey: z.string().min(32).max(44), // Wallet public key
  nonce: z.string().min(1), // Challenge nonce
});

const LinkWalletChallengeSchema = z.object({
  walletAddress: z.string().min(32).max(44),
});

const LinkWalletVerifySchema = z.object({
  walletAddress: z.string().min(32).max(44),
  nonce: z.string().min(1),
  signature: z.string().min(64),
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

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /auth/challenge
 * Generate a challenge for the user to sign
 */
export async function handleChallenge(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = getCorsHeaders(event);

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Parse request
    const body = JSON.parse(event.body || '{}');
    const parsed = ChallengeRequestSchema.safeParse(body);

    if (!parsed.success) {
      return jsonResponse(400, {
        error: 'Invalid request',
        details: parsed.error.issues,
      }, cors);
    }

    const { walletAddress } = parsed.data;
    const ipAddress = event.requestContext.http.sourceIp;

    // Create challenge (with rate limiting)
    const result = await createChallenge(walletAddress, ipAddress);

    // Check if rate limited
    if ('error' in result) {
      return jsonResponse(429, {
        error: result.error,
        retryAfter: result.retryAfter,
      }, {
        ...cors,
        'Retry-After': String(result.retryAfter),
      });
    }

    return jsonResponse(200, result, cors);
  } catch (error) {
    console.error('[WalletAuth] Challenge error:', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * POST /auth/verify
 * Verify signature and create session
 */
export async function handleVerify(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = getCorsHeaders(event);

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Parse request
    const body = JSON.parse(event.body || '{}');
    const parsed = VerifyRequestSchema.safeParse(body);

    if (!parsed.success) {
      return jsonResponse(400, {
        error: 'Invalid request',
        details: parsed.error.issues,
      }, cors);
    }

    const { signature, publicKey, nonce } = parsed.data;

    // Get client info
    const userAgent = event.headers['user-agent'] || event.headers['User-Agent'] || '';
    const ipAddress = event.requestContext.http.sourceIp;

    // Verify and create session
    const result = await verifyAndCreateSession(
      signature,
      publicKey,
      nonce,
      userAgent,
      ipAddress
    );

    if (!result.success || !result.session || !result.user) {
      // Include NFT gate info in error response for better UX
      return jsonResponse(401, { 
        error: result.error || 'Authentication failed',
        nftGate: result.nftGate,
      }, cors);
    }

    // Get gate status for the wallet (for access control on frontend)
    const gate = await getAccountGateStatus(
      result.session.accountId || (await getOrCreateAccountForWallet(result.user.walletAddress))
    );

    // Bypass NFT gate for internal test key (E2E testing)
    const isTestBypass = hasInternalTestKey(event);
    if (isTestBypass) {
      console.log('[WalletAuth] Internal test key detected - bypassing NFT gate requirements');
    }

    // Set session cookies (and clear any stale host-only cookie)
    const cookies = getSetSessionCookies(result.session.sessionToken);

    // Inhabitation is stored in the avatar ownership mapping; don't rely on UserRecord.inhabitedAvatarId.
    const inhabitedAvatar = await getInhabitedAvatar(result.user.walletAddress);

    const accountId = result.session.accountId || (await getOrCreateAccountForWallet(result.user.walletAddress));
    const account = await getAccountSummary(accountId);

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
        inhabitedAvatarId: inhabitedAvatar?.avatarId,
      },
      // Include NFT info for display
      nftGate: result.nftGate,
      // Include gate status for access control
      // Test bypass grants full access
      gateStatus: gate.gateStatus
        ? {
            nftsHeld: isTestBypass ? 999 : gate.gateStatus.nftsHeld,
            avatarsCreated: gate.gateStatus.avatarsCreated,
            availableSlots: isTestBypass ? 999 : gate.gateStatus.availableSlots,
            canCreate: isTestBypass ? true : gate.gateStatus.canCreate,
            canAbandon: isTestBypass ? true : gate.gateStatus.canAbandon,
            ownedNFTs: gate.gateStatus.ownedNFTs,
          }
        : {
            nftsHeld: isTestBypass ? 999 : 0,
            avatarsCreated: 0,
            availableSlots: isTestBypass ? 999 : 0,
            canCreate: isTestBypass,
            canAbandon: isTestBypass,
            ownedNFTs: [],
          },
      gateWallet: gate.gateWallet,
      gateStatusByWallet: gate.gateStatusByWallet,
    }, cors, cookies);
  } catch (error) {
    console.error('[WalletAuth] Verify error:', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * GET /auth/me
 * Get current authenticated user with gate status
 */
export async function handleMe(
  event: APIGatewayProxyEventV2,
  deps?: WalletAuthHandlerDeps
): Promise<APIGatewayProxyResultV2> {
  const cors = getCorsHeaders(event);

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    const resolvedDeps = deps || getDefaultDeps();

    // Get session from cookie
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(200, { authenticated: false }, cors);
    }

    // Get session and user
    const session = await resolvedDeps.walletAuth.getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(200, { authenticated: false }, {
        ...cors,
      }, getClearSessionCookies());
    }

    const accountId = session.accountId ||
      (resolvedDeps.accounts
        ? await resolvedDeps.accounts.getOrCreateAccountForWallet(session.user.walletAddress)
        : undefined);
    const account = accountId && resolvedDeps.accounts
      ? await resolvedDeps.accounts.getAccountSummary(accountId)
      : null;

    const gate = accountId && resolvedDeps.accountGate
      ? await resolvedDeps.accountGate.getAccountGateStatus(accountId)
      : { gateStatus: null, gateWallet: null, gateStatusByWallet: {} };

    // Inhabitation is stored in the avatar ownership mapping; don't rely on UserRecord.inhabitedAvatarId.
    const inhabitedAvatar = await resolvedDeps.avatarOwnership.getInhabitedAvatar(
      session.user.walletAddress
    );

    // Bypass NFT gate for internal test key (E2E testing)
    const isTestBypass = hasInternalTestKey(event);

    return jsonResponse(200, {
      authenticated: true,
      account,
      user: {
        walletAddress: session.user.walletAddress,
        displayName: session.user.displayName,
        avatarUrl: session.user.avatarUrl,
        inhabitedAvatarId: inhabitedAvatar?.avatarId,
        createdAt: session.user.createdAt,
        sessionCount: session.user.sessionCount,
      },
      // Test bypass grants full access
      gateStatus: gate.gateStatus
        ? {
            nftsHeld: isTestBypass ? 999 : gate.gateStatus.nftsHeld,
            avatarsCreated: gate.gateStatus.avatarsCreated,
            availableSlots: isTestBypass ? 999 : gate.gateStatus.availableSlots,
            canCreate: isTestBypass ? true : gate.gateStatus.canCreate,
            canAbandon: isTestBypass ? true : gate.gateStatus.canAbandon,
            ownedNFTs: gate.gateStatus.ownedNFTs,
          }
        : {
            nftsHeld: isTestBypass ? 999 : 0,
            avatarsCreated: 0,
            availableSlots: isTestBypass ? 999 : 0,
            canCreate: isTestBypass,
            canAbandon: isTestBypass,
            ownedNFTs: [],
          },
      gateWallet: gate.gateWallet,
      gateStatusByWallet: gate.gateStatusByWallet,
    }, cors);
  } catch (error) {
    console.error('[WalletAuth] Me error:', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * POST /auth/link/wallet/challenge
 * Create a signed message challenge to link a wallet identity to the current account.
 */
export async function handleLinkWalletChallenge(
  event: APIGatewayProxyEventV2,
  deps?: WalletAuthHandlerDeps
): Promise<APIGatewayProxyResultV2> {
  const cors = getCorsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    const resolvedDeps = deps || getDefaultDeps();
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(401, { error: 'Not authenticated' }, cors, getClearSessionCookies());
    }

    const session = await resolvedDeps.walletAuth.getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(401, { error: 'Session expired' }, cors, getClearSessionCookies());
    }

    const body = JSON.parse(event.body || '{}');
    const parsed = LinkWalletChallengeSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse(400, { error: 'Invalid request', details: parsed.error.issues }, cors);
    }

    const accountId = session.accountId ||
      (resolvedDeps.accounts
        ? await resolvedDeps.accounts.getOrCreateAccountForWallet(session.user.walletAddress)
        : undefined);
    if (!accountId) {
      return jsonResponse(500, { error: 'Account resolution unavailable' }, cors);
    }
    const result = await createLinkWalletChallenge({
      accountId,
      walletAddress: parsed.data.walletAddress,
    });

    if ('error' in result) {
      return jsonResponse(409, { error: result.error }, cors);
    }

    return jsonResponse(200, result, cors);
  } catch (error) {
    console.error('[WalletAuth] Link wallet challenge error:', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * POST /auth/link/wallet/verify
 * Verify signature and attach wallet identity to the current account.
 */
export async function handleLinkWalletVerify(
  event: APIGatewayProxyEventV2,
  deps?: WalletAuthHandlerDeps
): Promise<APIGatewayProxyResultV2> {
  const cors = getCorsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    const resolvedDeps = deps || getDefaultDeps();
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(401, { error: 'Not authenticated' }, cors, getClearSessionCookies());
    }

    const session = await resolvedDeps.walletAuth.getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(401, { error: 'Session expired' }, cors, getClearSessionCookies());
    }

    const body = JSON.parse(event.body || '{}');
    const parsed = LinkWalletVerifySchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse(400, { error: 'Invalid request', details: parsed.error.issues }, cors);
    }

    const accountId = session.accountId ||
      (resolvedDeps.accounts
        ? await resolvedDeps.accounts.getOrCreateAccountForWallet(session.user.walletAddress)
        : undefined);
    if (!accountId) {
      return jsonResponse(500, { error: 'Account resolution unavailable' }, cors);
    }
    const verifyResult = await verifyLinkWallet({
      accountId,
      walletAddress: parsed.data.walletAddress,
      nonce: parsed.data.nonce,
      signatureBase58: parsed.data.signature,
    });

    if (!verifyResult.success) {
      const status = verifyResult.error.includes('already linked') ? 409 : 400;
      return jsonResponse(status, { error: verifyResult.error }, cors);
    }

    const account = resolvedDeps.accounts ? await resolvedDeps.accounts.getAccountSummary(accountId) : null;
    return jsonResponse(200, { success: true, account }, cors);
  } catch (error) {
    console.error('[WalletAuth] Link wallet verify error:', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * POST /auth/logout
 * End current session
 */
export async function handleLogout(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = getCorsHeaders(event);

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Get session from cookie
    const sessionToken = getSessionFromCookie(event);
    if (sessionToken) {
      await deleteSession(sessionToken);
    }

    return jsonResponse(200, { success: true }, cors, getClearSessionCookies());
  } catch (error) {
    console.error('[WalletAuth] Logout error:', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

// ============================================================================
// INHABITATION ENDPOINTS
// ============================================================================

/**
 * GET /auth/unclaimed-avatars
 * List avatars available for inhabitation
 */
export async function handleUnclaimedAvatars(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = getCorsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    const avatars = await listUnclaimedAvatars();

    return jsonResponse(200, {
      avatars: avatars.map(a => ({
        avatarId: a.avatarId,
        name: a.name,
        description: a.description,
        avatarUrl: a.profileImage?.url,
        currentEra: a.currentEra || 0,
      })),
    }, cors);
  } catch (error) {
    console.error('[WalletAuth] Unclaimed avatars error:', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * GET /auth/gate-status
 * Get NFT gate status for current user
 */
export async function handleGateStatus(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = getCorsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Require authentication
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(401, { error: 'Authentication required' }, cors);
    }

    const session = await getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(401, { error: 'Session expired' }, {
        ...cors,
      }, getClearSessionCookies());
    }

    const gateStatus = await getGateStatus(session.user.walletAddress);

    return jsonResponse(200, { gateStatus }, cors);
  } catch (error) {
    console.error('[WalletAuth] Gate status error:', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * GET /auth/inhabitation
 * Get current inhabitation status (including ghost status)
 */
export async function handleInhabitationStatus(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = getCorsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Require authentication
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(401, { error: 'Authentication required' }, cors);
    }

    const session = await getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(401, { error: 'Session expired' }, {
        ...cors,
      }, getClearSessionCookies());
    }

    const info = await getInhabitationInfo(session.user.walletAddress);

    return jsonResponse(200, info, cors);
  } catch (error) {
    console.error('[WalletAuth] Inhabitation status error:', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * POST /auth/inhabit
 * Inhabit an unclaimed avatar (FREE - no NFT required)
 */
export async function handleInhabitAvatar(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = getCorsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Require authentication
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(401, { error: 'Authentication required' }, cors);
    }

    const session = await getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(401, { error: 'Session expired' }, {
        ...cors,
      }, getClearSessionCookies());
    }

    // Parse request
    const body = JSON.parse(event.body || '{}');
    const avatarId = body.avatarId;

    if (!avatarId || typeof avatarId !== 'string') {
      return jsonResponse(400, { error: 'avatarId is required' }, cors);
    }

    // Inhabit the avatar
    const result = await inhabitAvatar(session.user.walletAddress, avatarId);

    if (!result.success) {
      return jsonResponse(400, { error: result.error }, cors);
    }

    return jsonResponse(200, {
      success: true,
      avatarId: result.avatarId,
      avatarName: result.avatarName,
      avatarUrl: result.avatarUrl,
      era: result.era,
    }, cors);
  } catch (error) {
    console.error('[WalletAuth] Inhabit error:', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * POST /auth/can-abandon
 * Check if user can abandon their current avatar
 */
export async function handleCanAbandon(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = getCorsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Require authentication
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(401, { error: 'Authentication required' }, cors);
    }

    const session = await getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(401, { error: 'Session expired' }, {
        ...cors,
      }, getClearSessionCookies());
    }

    const result = await canAbandon(session.user.walletAddress);

    return jsonResponse(200, {
      canAbandon: result.canAbandon,
      gateStatus: result.gateStatus,
      inhabitedAvatar: result.inhabitedAvatar ? {
        avatarId: result.inhabitedAvatar.avatarId,
        name: result.inhabitedAvatar.name,
        avatarUrl: result.inhabitedAvatar.profileImage?.url,
        currentEra: result.inhabitedAvatar.currentEra || 0,
      } : null,
    }, cors);
  } catch (error) {
    console.error('[WalletAuth] Can abandon error:', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * POST /auth/abandon
 * Abandon the currently inhabited avatar (REQUIRES Gate NFT burn)
 *
 * Request body:
 * - burnTxSignature: REQUIRED - The signature of the Gate NFT burn transaction
 *
 * Flow:
 * 1. Client burns Gate NFT using wallet
 * 2. Client sends burn transaction signature to this endpoint
 * 3. Backend verifies burn on-chain
 * 4. Backend releases the avatar and increments era
 * 5. Client can then mint lineage NFT with returned metadata
 *
 * Returns info needed for lineage NFT minting
 */
export async function handleAbandonAvatar(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = getCorsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Require authentication
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(401, { error: 'Authentication required' }, cors);
    }

    const session = await getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(401, { error: 'Session expired' }, {
        ...cors,
      }, getClearSessionCookies());
    }

    const body = JSON.parse(event.body || '{}');
    const burnTxSignature = body.burnTxSignature;

    // Burn signature is REQUIRED
    if (!burnTxSignature || typeof burnTxSignature !== 'string') {
      return jsonResponse(400, {
        error: 'burnTxSignature is required. You must burn a Gate NFT first.',
      }, cors);
    }

    const inhabitedAvatar = await getInhabitedAvatar(session.user.walletAddress);
    if (!inhabitedAvatar) {
      return jsonResponse(400, {
        error: 'You do not currently inhabit any avatar',
      }, cors);
    }

    const lineageMint = await prepareLineageMint(
      inhabitedAvatar.avatarId,
      session.user.walletAddress
    );

    if (!lineageMint.success) {
      return jsonResponse(400, {
        error: lineageMint.error || 'Failed to prepare lineage mint',
      }, cors);
    }

    // Abandon the avatar (includes burn verification)
    const result = await abandonAvatar(
      session.user.walletAddress,
      burnTxSignature
    );

    if (!result.success) {
      return jsonResponse(400, {
        error: result.error,
        gateStatus: result.gateStatus,
      }, cors);
    }

    return jsonResponse(200, {
      success: true,
      avatarId: result.avatarId,
      avatarName: result.avatarName,
      era: result.era,
      lineageNftMint: result.lineageNftMint,
      burnedMint: result.burnedMint,
      lineageMetadata: lineageMint.metadata,
      gateStatus: result.gateStatus,
    }, cors);
  } catch (error) {
    console.error('[WalletAuth] Abandon error:', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

// ============================================================================
// ASCENSION ENDPOINTS
// ============================================================================

/**
 * GET /avatar/:id/ascension-status
 * Get ascension status for an avatar
 */
export async function handleAscensionStatus(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = getCorsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Extract avatarId from path
    const pathMatch = event.rawPath.match(/\/avatar\/([^/]+)\/ascension-status/);
    const avatarId = pathMatch?.[1];

    if (!avatarId) {
      return jsonResponse(400, { error: 'Avatar ID required' }, cors);
    }

    const status = await getAvatarAscensionStatus(avatarId);

    return jsonResponse(200, status, cors);
  } catch (error) {
    console.error('[WalletAuth] Ascension status error:', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * POST /avatar/:id/ascend/preflight
 * Check if user can ascend an avatar (requirements check)
 */
export async function handleAscensionPreflight(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = getCorsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Require authentication
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(401, { error: 'Authentication required' }, cors);
    }

    const session = await getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(401, { error: 'Session expired' }, cors, getClearSessionCookies());
    }

    // Extract avatarId from path
    const pathMatch = event.rawPath.match(/\/avatar\/([^/]+)\/ascend\/preflight/);
    const avatarId = pathMatch?.[1];

    if (!avatarId) {
      return jsonResponse(400, { error: 'Avatar ID required' }, cors);
    }

    const result = await preflightAscend(avatarId, session.user.walletAddress);

    return jsonResponse(200, result, cors);
  } catch (error) {
    console.error('[WalletAuth] Ascension preflight error:', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * POST /avatar/:id/ascend
 * Execute ascension after burns have been verified
 *
 * Request body:
 * - orbBurnSignature: REQUIRED - The signature of the Orb NFT burn transaction
 * - ratiBurnSignature: REQUIRED - The signature of the RATI token burn transaction
 * - nftMint: REQUIRED - The mint address of the newly created Ascension NFT
 */
export async function handleExecuteAscension(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = getCorsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Require authentication
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(401, { error: 'Authentication required' }, cors);
    }

    const session = await getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(401, { error: 'Session expired' }, cors, getClearSessionCookies());
    }

    // Extract avatarId from path
    const pathMatch = event.rawPath.match(/\/avatar\/([^/]+)\/ascend$/);
    const avatarId = pathMatch?.[1];

    if (!avatarId) {
      return jsonResponse(400, { error: 'Avatar ID required' }, cors);
    }

    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { orbBurnSignature, ratiBurnSignature, nftMint } = body;

    if (!orbBurnSignature || typeof orbBurnSignature !== 'string') {
      return jsonResponse(400, {
        error: 'orbBurnSignature is required. You must burn an Orb NFT first.',
      }, cors);
    }

    if (!ratiBurnSignature || typeof ratiBurnSignature !== 'string') {
      return jsonResponse(400, {
        error: 'ratiBurnSignature is required. You must burn RATI tokens first.',
      }, cors);
    }

    if (!nftMint || typeof nftMint !== 'string') {
      return jsonResponse(400, {
        error: 'nftMint is required. You must provide the Ascension NFT mint address.',
      }, cors);
    }

    // First do a preflight check to get the required RATI amount
    const preflight = await preflightAscend(avatarId, session.user.walletAddress);
    if (!preflight.canAscend) {
      return jsonResponse(400, {
        error: preflight.error || 'Cannot ascend this avatar',
        ...preflight,
      }, cors);
    }

    // Verify both burns on-chain before accepting the ascension.
    const burnVerification = await verifyAscensionBurns(
      session.user.walletAddress,
      orbBurnSignature,
      ratiBurnSignature,
      preflight.requiredRatiBurn
    );

    if (!burnVerification.verified) {
      return jsonResponse(400, {
        error: burnVerification.error || 'Burn verification failed',
        orb: burnVerification.orbResult,
        rati: burnVerification.ratiResult,
      }, cors);
    }

    const burnedRatiAmount = burnVerification.ratiResult.burnedAmount ?? preflight.requiredRatiBurn;

    // Record the burn so tiers/leaderboard reflect verified burns.
    await recordBurn({
      avatarId,
      signature: ratiBurnSignature,
      amount: burnedRatiAmount,
      walletAddress: session.user.walletAddress,
    });

    // Execute the ascension
    const result = await executeAscension(
      avatarId,
      session.user.walletAddress,
      nftMint,
      orbBurnSignature,
      ratiBurnSignature,
      burnedRatiAmount
    );

    if (!result.success) {
      return jsonResponse(400, {
        error: result.error || 'Ascension failed',
      }, cors);
    }

    return jsonResponse(200, {
      success: true,
      avatarId: result.avatarId,
      avatarName: result.avatarName,
      ascendedNftMint: result.ascendedNftMint,
      ascendedAt: result.ascendedAt,
      message: `Avatar has been ascended! Persona and profile image are now permanently locked.`,
    }, cors);
  } catch (error) {
    console.error('[WalletAuth] Execute ascension error:', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * Main router for /auth/* endpoints
 */
export async function handleWalletAuth(
  event: APIGatewayProxyEventV2,
  depsOrContext?: WalletAuthHandlerDeps | unknown
): Promise<APIGatewayProxyResultV2> {
  const deps = depsOrContext && 'walletAuth' in (depsOrContext as object)
    ? (depsOrContext as WalletAuthHandlerDeps)
    : undefined;
  const resolvedDeps = deps || getDefaultDeps();

  const rawPath = event.rawPath;
  const path = rawPath === '/api'
    ? '/'
    : rawPath.startsWith('/api/')
      ? rawPath.slice('/api'.length)
      : rawPath;
  const method = event.requestContext.http.method;
  const cors = getCorsHeaders(event);

  // Handle preflight for all auth routes
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  // Route Crossmint auth to separate handler
  if (path.startsWith('/auth/crossmint')) {
    return handleCrossmintAuth(event);
  }

  // Route Privy auth to separate handler
  if (path.startsWith('/auth/privy') || path.startsWith('/auth/link/privy')) {
    return handlePrivyAuth(event);
  }

  // Route to appropriate handler
  if (path === '/auth/challenge' && method === 'POST') {
    return handleChallenge(event);
  }

  if (path === '/auth/verify' && method === 'POST') {
    return handleVerify(event);
  }

  if (path === '/auth/me' && method === 'GET') {
    return handleMe(event, resolvedDeps);
  }

  if (path === '/auth/link/wallet/challenge' && method === 'POST') {
    return handleLinkWalletChallenge(event, resolvedDeps);
  }

  if (path === '/auth/link/wallet/verify' && method === 'POST') {
    return handleLinkWalletVerify(event, resolvedDeps);
  }

  if (path === '/auth/logout' && method === 'POST') {
    return handleLogout(event);
  }

  // Inhabitation endpoints
  if (path === '/auth/unclaimed-avatars' && method === 'GET') {
    return handleUnclaimedAvatars(event);
  }

  if (path === '/auth/gate-status' && method === 'GET') {
    return handleGateStatus(event);
  }

  if (path === '/auth/inhabitation' && method === 'GET') {
    return handleInhabitationStatus(event);
  }

  if (path === '/auth/inhabit' && method === 'POST') {
    return handleInhabitAvatar(event);
  }

  if (path === '/auth/can-abandon' && method === 'GET') {
    return handleCanAbandon(event);
  }

  if (path === '/auth/abandon' && method === 'POST') {
    return handleAbandonAvatar(event);
  }

  // Ascension endpoints
  if (path.match(/^\/avatar\/[^/]+\/ascension-status$/) && method === 'GET') {
    return handleAscensionStatus(event);
  }

  if (path.match(/^\/avatar\/[^/]+\/ascend\/preflight$/) && method === 'POST') {
    return handleAscensionPreflight(event);
  }

  if (path.match(/^\/avatar\/[^/]+\/ascend$/) && method === 'POST') {
    return handleExecuteAscension(event);
  }

  return jsonResponse(404, { error: 'Not found' }, cors);
}

// =============================================================================
// LEGACY API - Deprecated aliases for backwards compatibility
// =============================================================================

/** @deprecated Use handleUnclaimedAvatars instead */
export const handleUnclaimedAgents = handleUnclaimedAvatars;
/** @deprecated Use handleInhabitAvatar instead */
export const handleInhabitAgent = handleInhabitAvatar;
/** @deprecated Use handleAbandonAvatar instead */
export const handleAbandonAgent = handleAbandonAvatar;
