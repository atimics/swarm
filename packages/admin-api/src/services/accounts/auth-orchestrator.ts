/**
 * Auth Orchestrator
 *
 * Provides a single entry point for authentication that combines identity resolution,
 * session creation, and challenge verification. Replaces the scattered auth logic
 * across wallet-auth, crossmint-auth, and privy-auth handlers.
 */
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  resolveAccountForIdentity,
  linkIdentity,
  getAccountIdForIdentity,
  type Identity,
} from './identity-service.js';
import {
  createSession,
  type SessionRecord,
} from './session-service.js';
import {
  createAuthChallenge,
  createLinkChallenge,
  consumeChallenge,
} from './challenge-service.js';
import { recordAccountSession, getAccountSummary, type AccountSummary } from '../accounts.js';
import { checkNFTGate, type NFTGateResult } from '../nft-gate.js';

// ============================================================================
// Types
// ============================================================================

export interface AuthenticateWalletParams {
  signature: string;
  publicKey: string;
  nonce: string;
  userAgent?: string;
  ipAddress?: string;
}

export interface AuthenticateCrossmintParams {
  crossmintUserId: string;
  walletAddress?: string;
  email?: string;
  userAgent?: string;
  ipAddress?: string;
}

export interface AuthenticatePrivyParams {
  privyUserId: string;
  walletAddress?: string;
  email?: string;
  userAgent?: string;
  ipAddress?: string;
}

export interface AuthenticateResult {
  success: boolean;
  session?: SessionRecord;
  account?: AccountSummary;
  nftGate?: NFTGateResult;
  error?: string;
  conflict?: {
    identity: Identity;
    existingAccountId: string;
  };
}

export interface LinkWalletParams {
  accountId: string;
  walletAddress: string;
  signature: string;
  nonce: string;
}

export interface LinkWalletResult {
  success: boolean;
  account?: AccountSummary;
  error?: string;
  conflict?: {
    identity: Identity;
    existingAccountId: string;
  };
}

// ============================================================================
// Signature Verification
// ============================================================================

/**
 * Verify a Solana wallet signature.
 */
export function verifyWalletSignature(
  message: string,
  signatureBase58: string,
  publicKeyBase58: string
): boolean {
  try {
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.decode(signatureBase58);
    const publicKeyBytes = bs58.decode(publicKeyBase58);

    // Solana public keys are 32 bytes
    if (publicKeyBytes.length !== 32) {
      console.log(`[AuthOrchestrator] Invalid public key length: ${publicKeyBytes.length}`);
      return false;
    }

    // Solana signatures are 64 bytes
    if (signatureBytes.length !== 64) {
      console.log(`[AuthOrchestrator] Invalid signature length: ${signatureBytes.length}`);
      return false;
    }

    const isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
    return isValid;
  } catch (error) {
    console.error('[AuthOrchestrator] Signature verification error:', error);
    return false;
  }
}

// ============================================================================
// Wallet Authentication
// ============================================================================

/**
 * Create an auth challenge for wallet sign-in.
 */
export async function createWalletChallenge(
  walletAddress: string,
  idempotencyKey?: string
): Promise<{ nonce: string; message: string; expiresAt: number }> {
  return createAuthChallenge({ walletAddress, idempotencyKey });
}

/**
 * Authenticate a user with a wallet signature.
 * This is the main entry point for wallet-based authentication.
 */
export async function authenticateWallet(
  params: AuthenticateWalletParams
): Promise<AuthenticateResult> {
  const { signature, publicKey, nonce, userAgent, ipAddress } = params;

  // 1. Consume the challenge (retry-safe)
  const requestId = `${publicKey}:${nonce}:${Date.now()}`;
  const challengeResult = await consumeChallenge('auth', nonce, requestId);

  if (!challengeResult.success) {
    return { success: false, error: challengeResult.error };
  }

  const challenge = challengeResult.challenge;

  // Verify the wallet matches the challenge
  if (challenge.walletAddress !== publicKey) {
    return { success: false, error: 'Wallet address does not match challenge' };
  }

  // 2. Verify the signature
  const isValid = verifyWalletSignature(challenge.message, signature, publicKey);
  if (!isValid) {
    console.log(`[AuthOrchestrator] Invalid signature for wallet=${publicKey.slice(0, 8)}...`);
    return { success: false, error: 'Invalid signature' };
  }

  // 3. Check NFT gate (non-blocking)
  const nftGate = await checkNFTGate(publicKey);
  if (!nftGate.allowed) {
    console.log(`[AuthOrchestrator] No Orb NFT for wallet=${publicKey.slice(0, 8)}... (limited access)`);
  }

  // 4. Resolve account for this wallet
  const accountResult = await resolveAccountForIdentity({
    primaryIdentity: { type: 'wallet', providerId: publicKey },
    createIfNotFound: true,
  });

  if (!accountResult.success) {
    return {
      success: false,
      error: accountResult.error,
      conflict: accountResult.conflict,
    };
  }

  // 5. Record session activity on account
  await recordAccountSession(accountResult.accountId);

  // 6. Create session
  const session = await createSession({
    accountId: accountResult.accountId,
    walletAddress: publicKey,
    authProvider: 'wallet',
    authProviderId: publicKey,
    userAgent,
    ipAddress,
  });

  // 7. Get account summary
  const account = await getAccountSummary(accountResult.accountId);

  console.log(`[AuthOrchestrator] Wallet auth successful for wallet=${publicKey.slice(0, 8)}...`);

  return {
    success: true,
    session,
    account: account ?? undefined,
    nftGate,
  };
}

// ============================================================================
// Crossmint Authentication
// ============================================================================

/**
 * Authenticate a user with Crossmint credentials.
 * This should be called after Crossmint JWT verification.
 */
export async function authenticateCrossmint(
  params: AuthenticateCrossmintParams
): Promise<AuthenticateResult> {
  const { crossmintUserId, walletAddress, userAgent, ipAddress } = params;

  // Build identities to link
  const primaryIdentity: Identity = { type: 'crossmint', providerId: crossmintUserId };
  const additionalIdentities: Identity[] = [];

  if (walletAddress) {
    additionalIdentities.push({ type: 'wallet', providerId: walletAddress });
  }

  // Check NFT gate if we have a wallet
  let nftGate: NFTGateResult | undefined;
  if (walletAddress) {
    nftGate = await checkNFTGate(walletAddress);
    if (!nftGate.allowed) {
      console.log(`[AuthOrchestrator] No Orb NFT for wallet=${walletAddress.slice(0, 8)}... (limited access)`);
    }
  }

  // Resolve account
  const accountResult = await resolveAccountForIdentity({
    primaryIdentity,
    additionalIdentities,
    createIfNotFound: true,
  });

  if (!accountResult.success) {
    return {
      success: false,
      error: accountResult.error,
      conflict: accountResult.conflict,
    };
  }

  // Record session activity
  await recordAccountSession(accountResult.accountId);

  // Create session
  const session = await createSession({
    accountId: accountResult.accountId,
    walletAddress: walletAddress || crossmintUserId, // Use crossmint ID as fallback
    authProvider: 'crossmint',
    authProviderId: crossmintUserId,
    userAgent,
    ipAddress,
  });

  // Get account summary
  const account = await getAccountSummary(accountResult.accountId);

  console.log(`[AuthOrchestrator] Crossmint auth successful for user=${crossmintUserId.slice(0, 8)}...`);

  return {
    success: true,
    session,
    account: account ?? undefined,
    nftGate,
  };
}

// ============================================================================
// Privy Authentication
// ============================================================================

/**
 * Authenticate a user with Privy credentials.
 * This should be called after Privy access token verification.
 */
export async function authenticatePrivy(
  params: AuthenticatePrivyParams
): Promise<AuthenticateResult> {
  const { privyUserId, walletAddress, userAgent, ipAddress } = params;

  // Build identities to link
  const primaryIdentity: Identity = { type: 'privy', providerId: privyUserId };
  const additionalIdentities: Identity[] = [];

  if (walletAddress) {
    additionalIdentities.push({ type: 'wallet', providerId: walletAddress });
  }

  // Check NFT gate if we have a wallet
  let nftGate: NFTGateResult | undefined;
  if (walletAddress) {
    nftGate = await checkNFTGate(walletAddress);
    if (!nftGate.allowed) {
      console.log(`[AuthOrchestrator] No Orb NFT for wallet=${walletAddress.slice(0, 8)}... (limited access)`);
    }
  }

  // Resolve account
  const accountResult = await resolveAccountForIdentity({
    primaryIdentity,
    additionalIdentities,
    createIfNotFound: true,
  });

  if (!accountResult.success) {
    return {
      success: false,
      error: accountResult.error,
      conflict: accountResult.conflict,
    };
  }

  // Record session activity
  await recordAccountSession(accountResult.accountId);

  // Create session
  const session = await createSession({
    accountId: accountResult.accountId,
    walletAddress: walletAddress || privyUserId, // Use privy ID as fallback
    authProvider: 'privy',
    authProviderId: privyUserId,
    userAgent,
    ipAddress,
  });

  // Get account summary
  const account = await getAccountSummary(accountResult.accountId);

  console.log(`[AuthOrchestrator] Privy auth successful for user=${privyUserId.slice(0, 8)}...`);

  return {
    success: true,
    session,
    account: account ?? undefined,
    nftGate,
  };
}

// ============================================================================
// Identity Linking
// ============================================================================

/**
 * Create a challenge for linking a wallet to an existing account.
 */
export async function createWalletLinkChallenge(
  accountId: string,
  walletAddress: string,
  idempotencyKey?: string
): Promise<{ nonce: string; message: string; expiresAt: number } | { error: string }> {
  // Check if wallet is already linked to a different account
  const existingAccountId = await getAccountIdForIdentity({ type: 'wallet', providerId: walletAddress });
  if (existingAccountId && existingAccountId !== accountId) {
    return { error: 'Wallet is already linked to another account' };
  }

  return createLinkChallenge({ accountId, walletAddress, idempotencyKey });
}

/**
 * Verify a wallet link signature and link the wallet to an account.
 */
export async function verifyAndLinkWallet(params: LinkWalletParams): Promise<LinkWalletResult> {
  const { accountId, walletAddress, signature, nonce } = params;

  // 1. Consume the challenge (retry-safe)
  const requestId = `${accountId}:${walletAddress}:${nonce}:${Date.now()}`;
  const challengeResult = await consumeChallenge('link', nonce, requestId);

  if (!challengeResult.success) {
    return { success: false, error: challengeResult.error };
  }

  const challenge = challengeResult.challenge;

  // Verify the challenge matches the request
  if (challenge.accountId !== accountId || challenge.walletAddress !== walletAddress) {
    return { success: false, error: 'Challenge does not match request' };
  }

  // 2. Verify the signature
  const isValid = verifyWalletSignature(challenge.message, signature, walletAddress);
  if (!isValid) {
    return { success: false, error: 'Invalid signature' };
  }

  // 3. Link the identity
  const linkResult = await linkIdentity(accountId, { type: 'wallet', providerId: walletAddress });

  if (!linkResult.success) {
    return {
      success: false,
      error: linkResult.error,
      conflict: linkResult.conflict,
    };
  }

  // 4. Get updated account summary
  const account = await getAccountSummary(accountId);

  console.log(`[AuthOrchestrator] Wallet linked to account=${accountId}`);

  return {
    success: true,
    account: account ?? undefined,
  };
}

/**
 * Link a Crossmint identity to an existing account.
 */
export async function linkCrossmint(
  accountId: string,
  crossmintUserId: string,
  walletAddress?: string
): Promise<LinkWalletResult> {
  // Link Crossmint identity
  const crossmintResult = await linkIdentity(accountId, {
    type: 'crossmint',
    providerId: crossmintUserId,
  });

  if (!crossmintResult.success) {
    return {
      success: false,
      error: crossmintResult.error,
      conflict: crossmintResult.conflict,
    };
  }

  // Link wallet if provided
  if (walletAddress) {
    const walletResult = await linkIdentity(accountId, {
      type: 'wallet',
      providerId: walletAddress,
    });

    if (!walletResult.success) {
      return {
        success: false,
        error: walletResult.error,
        conflict: walletResult.conflict,
      };
    }
  }

  const account = await getAccountSummary(accountId);

  return {
    success: true,
    account: account ?? undefined,
  };
}

/**
 * Link a Privy identity to an existing account.
 */
export async function linkPrivy(
  accountId: string,
  privyUserId: string,
  walletAddress?: string
): Promise<LinkWalletResult> {
  // Link Privy identity
  const privyResult = await linkIdentity(accountId, {
    type: 'privy',
    providerId: privyUserId,
  });

  if (!privyResult.success) {
    return {
      success: false,
      error: privyResult.error,
      conflict: privyResult.conflict,
    };
  }

  // Link wallet if provided
  if (walletAddress) {
    const walletResult = await linkIdentity(accountId, {
      type: 'wallet',
      providerId: walletAddress,
    });

    if (!walletResult.success) {
      return {
        success: false,
        error: walletResult.error,
        conflict: walletResult.conflict,
      };
    }
  }

  const account = await getAccountSummary(accountId);

  return {
    success: true,
    account: account ?? undefined,
  };
}

// ============================================================================
// Session Management (Re-exports for convenience)
// ============================================================================

export { getAndTouchSession, deleteSession } from './session-service.js';
export type { SessionRecord } from './session-service.js';
