/**
 * Crossmint Authentication Service
 * Handles authentication for users signing in via Crossmint (email/social)
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomBytes } from 'crypto';
import { checkNFTGate, type NFTGateResult } from './nft-gate.js';
import type { UserRecord, SessionRecord } from './wallet-auth.js';
import { recordAccountSession } from './accounts.js';
import {
  resolveOnboardingAuthAccount,
  type OnboardingAuthFailureResult,
  type OnboardingAuthOutcome,
} from './accounts/onboarding-auth-resolver.js';
import { upsertActiveUserSlotOnLogin } from './active-user-limit.js';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ADMIN_TABLE = process.env.ADMIN_TABLE!;
const CROSSMINT_API_KEY = process.env.CROSSMINT_API_KEY;

// Session configuration (same as wallet auth)
const SESSION_TTL_HOURS = 24;

// ============================================================================
// Types
// ============================================================================

export interface CrossmintVerifyRequest {
  jwt: string;
  userId: string;
  email?: string;
  walletAddress?: string;
}

export interface CrossmintAuthResult {
  success: boolean;
  session?: SessionRecord;
  user?: UserRecord & { email?: string };
  nftGate?: NFTGateResult;
  error?: string;
  code?: OnboardingAuthFailureResult['code'];
  outcome?: OnboardingAuthOutcome;
  switchAccountId?: string;
  requiredIntent?: OnboardingAuthFailureResult['requiredIntent'];
  conflict?: { type: 'wallet' | 'crossmint'; providerId: string; existingAccountId: string };
}

// ============================================================================
// Session Management
// ============================================================================

/**
 * Generate a session token
 */
function generateSessionToken(): string {
  return randomBytes(48).toString('base64url');
}

/**
 * Create a new session for a Crossmint user
 */
async function createSession(
  walletAddress: string,
  crossmintUserId: string,
  accountId: string,
  userAgent?: string,
  ipAddress?: string
): Promise<SessionRecord> {
  const sessionToken = generateSessionToken();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_HOURS * 60 * 60 * 1000;

  const record: SessionRecord = {
    pk: `SESSION#${sessionToken}`,
    sk: 'DATA',
    sessionToken,
    walletAddress,
    accountId,
    createdAt: now,
    expiresAt,
    lastActiveAt: now,
    userAgent,
    ipAddress,
    ttl: Math.floor(expiresAt / 1000),
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: {
      ...record,
      authProvider: 'crossmint',
      crossmintUserId,
    },
  }));

  console.log(`[CrossmintAuth] Created session for crossmintUser=${crossmintUserId}, wallet=${walletAddress.slice(0, 8)}...`);

  return record;
}

// ============================================================================
// User Management
// ============================================================================

/**
 * Get or create a user record for a Crossmint user
 * Users are keyed by wallet address for consistency with wallet auth
 */
async function getOrCreateUser(
  walletAddress: string,
  email?: string,
  crossmintUserId?: string
): Promise<UserRecord & { email?: string }> {
  const pk = `USER#${walletAddress}`;

  // Try to get existing user
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk, sk: 'PROFILE' },
  }));

  const now = Date.now();

  if (result.Item) {
    // Update last seen, session count, and optionally email
    const user = result.Item as UserRecord & { email?: string };
    const updateExpr = email
      ? 'SET lastSeenAt = :now, sessionCount = sessionCount + :one, email = :email, authProvider = :ap'
      : 'SET lastSeenAt = :now, sessionCount = sessionCount + :one, authProvider = :ap';
    const exprValues: Record<string, unknown> = {
      ':now': now,
      ':one': 1,
      ':ap': 'crossmint',
    };
    if (email) {
      exprValues[':email'] = email;
    }

    await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: { pk, sk: 'PROFILE' },
      UpdateExpression: updateExpr,
      ExpressionAttributeValues: exprValues,
    }));

    return { ...user, lastSeenAt: now, sessionCount: user.sessionCount + 1, email: email || user.email };
  }

  // Create new user
  const newUser: UserRecord & { email?: string; authProvider: string; crossmintUserId?: string } = {
    pk,
    sk: 'PROFILE',
    walletAddress,
    email,
    authProvider: 'crossmint',
    crossmintUserId,
    createdAt: now,
    lastSeenAt: now,
    sessionCount: 1,
  };

  // Use email as display name if available
  if (email) {
    newUser.displayName = email.split('@')[0];
  }

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: newUser,
  }));

  console.log(`[CrossmintAuth] Created new user for crossmintUser=${crossmintUserId}, wallet=${walletAddress.slice(0, 8)}...`);

  return newUser;
}

// ============================================================================
// JWT Verification (Optional - Crossmint SDK handles client-side verification)
// ============================================================================

/**
 * Verify Crossmint JWT with their API
 * Note: This is optional extra verification - the SDK already validates on client
 */
async function verifyCrossmintJwt(jwt: string): Promise<boolean> {
  // If no API key configured, trust the client-side SDK verification
  if (!CROSSMINT_API_KEY) {
    console.log('[CrossmintAuth] No API key configured - trusting client-side verification');
    return true;
  }

  try {
    // Crossmint JWT verification endpoint
    const response = await fetch('https://www.crossmint.com/api/2022-06-09/session/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': CROSSMINT_API_KEY,
      },
      body: JSON.stringify({ jwt }),
    });

    if (!response.ok) {
      console.error('[CrossmintAuth] JWT verification failed:', response.status);
      return false;
    }

    const data = await response.json() as { valid?: boolean };
    return data.valid === true;
  } catch (error) {
    console.error('[CrossmintAuth] JWT verification error:', error);
    // On error, trust the client-side verification
    return true;
  }
}

export async function verifyCrossmintJwtForLink(jwt: string): Promise<boolean> {
  return verifyCrossmintJwt(jwt);
}

// ============================================================================
// Wallet Address Resolution
// ============================================================================

/**
 * Get Crossmint user's Solana wallet address
 * The SDK should provide this, but we can fetch it if needed
 */
async function getCrossmintWallet(userId: string): Promise<string | null> {
  if (!CROSSMINT_API_KEY) {
    console.log('[CrossmintAuth] No API key - cannot fetch wallet from Crossmint');
    return null;
  }

  try {
    // Fetch user's wallet from Crossmint API
    const response = await fetch(`https://www.crossmint.com/api/v1-alpha2/wallets/userId:${userId}`, {
      headers: {
        'X-API-KEY': CROSSMINT_API_KEY,
      },
    });

    if (!response.ok) {
      console.error('[CrossmintAuth] Failed to fetch wallet:', response.status);
      return null;
    }

    const data = await response.json() as { address?: string; publicKey?: string };
    // Return the Solana wallet address
    return data.address || data.publicKey || null;
  } catch (error) {
    console.error('[CrossmintAuth] Wallet fetch error:', error);
    return null;
  }
}

export async function resolveCrossmintWalletAddress(params: {
  userId: string;
  walletAddress?: string;
}): Promise<string | null> {
  if (params.walletAddress) return params.walletAddress;
  return getCrossmintWallet(params.userId);
}

// ============================================================================
// Main Auth Flow
// ============================================================================

/**
 * Verify Crossmint auth and create a session
 * This is called when a user completes Crossmint login on the frontend
 */
export async function verifyCrossmintAuth(
  request: CrossmintVerifyRequest,
  userAgent?: string,
  ipAddress?: string
): Promise<CrossmintAuthResult> {
  const { jwt, userId, email, walletAddress: providedWallet } = request;

  // 1. Optionally verify JWT with Crossmint API
  const jwtValid = await verifyCrossmintJwt(jwt);
  if (!jwtValid) {
    return { success: false, error: 'Invalid authentication token' };
  }

  // 2. Get wallet address (from request or from Crossmint API)
  let walletAddress: string | undefined = providedWallet;
  if (!walletAddress) {
    walletAddress = await getCrossmintWallet(userId) ?? undefined;
  }

  if (!walletAddress) {
    return { success: false, error: 'Could not determine wallet address' };
  }

  console.log(`[CrossmintAuth] Verifying user=${userId}, email=${email}, wallet=${walletAddress.slice(0, 8)}...`);

  // 3. Check NFT gate - same as wallet auth
  const nftGate = await checkNFTGate(walletAddress);
  if (!nftGate.allowed) {
    console.log(`[CrossmintAuth] No Orb NFT for wallet=${walletAddress.slice(0, 8)}... (limited access)`);
  }

  // 4. Get or create user (keyed by wallet address)
  const user = await getOrCreateUser(walletAddress, email, userId);

  // 4b. Resolve/create account for this Crossmint user and wallet.
  // This canonical resolution path prevents implicit account switching.
  const accountResolution = await resolveOnboardingAuthAccount({
    mode: 'identity',
    primaryIdentity: { type: 'crossmint', providerId: userId },
    additionalIdentities: [{ type: 'wallet', providerId: walletAddress }],
    createIfNotFound: true,
  });

  if (!accountResolution.success) {
    const conflictIdentity = accountResolution.identity;
    const conflictType = conflictIdentity?.type === 'wallet' ? 'wallet' : 'crossmint';
    const conflictProviderId = conflictIdentity?.providerId ?? userId;

    return {
      success: false,
      error: accountResolution.error,
      code: accountResolution.code,
      outcome: accountResolution.outcome,
      switchAccountId: accountResolution.switchAccountId,
      requiredIntent: accountResolution.requiredIntent,
      conflict: accountResolution.switchAccountId
        ? {
            type: conflictType,
            providerId: conflictProviderId,
            existingAccountId: accountResolution.switchAccountId,
          }
        : undefined,
    };
  }

  const accountId = accountResolution.accountId;

  // Track unified account activity + refresh active-user slot (if enabled)
  await recordAccountSession(accountId);
  await upsertActiveUserSlotOnLogin({ accountId, walletAddress });

  // 5. Create session
  const session = await createSession(walletAddress, userId, accountId, userAgent, ipAddress);

  console.log(`[CrossmintAuth] Auth successful for user=${userId}, wallet=${walletAddress.slice(0, 8)}...`);

  return {
    success: true,
    session,
    user,
    nftGate,
    outcome: accountResolution.outcome,
  };
}
