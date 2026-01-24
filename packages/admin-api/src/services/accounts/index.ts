/**
 * Accounts Services
 *
 * Unified account and identity management system.
 */

// Identity management
export {
  resolveAccountForIdentity,
  linkIdentity,
  unlinkIdentity,
  getAccountIdForIdentity,
  getAccountIdentities,
  type Identity,
  type IdentityType,
  type ResolveAccountResult,
  type LinkIdentityResult,
  type UnlinkIdentityResult,
} from './identity-service.js';

// Challenge management
export {
  createAuthChallenge,
  createLinkChallenge,
  consumeChallenge,
  getChallenge,
  type ChallengeType,
  type ChallengeRecord,
} from './challenge-service.js';

// Session management
export {
  createSession,
  getSession,
  touchSession,
  deleteSession,
  getAndTouchSession,
  validateSession,
  type AuthProvider,
  type SessionRecord,
  type CreateSessionParams,
  type ValidatedSession,
} from './session-service.js';

// Auth orchestration (main entry point)
export {
  // Wallet auth
  createWalletChallenge,
  authenticateWallet,
  verifyWalletSignature,
  // Crossmint auth
  authenticateCrossmint,
  // Privy auth
  authenticatePrivy,
  // Identity linking
  createWalletLinkChallenge,
  verifyAndLinkWallet,
  linkCrossmint,
  linkPrivy,
  // Types
  type AuthenticateWalletParams,
  type AuthenticateCrossmintParams,
  type AuthenticatePrivyParams,
  type AuthenticateResult,
  type LinkWalletParams,
  type LinkWalletResult,
} from './auth-orchestrator.js';
