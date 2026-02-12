/**
 * Unified Authentication Store
 * Privy-backed auth state exposed as a stable app-level interface.
 */
import type { GateStatus } from './gateStatus';
import { usePrivyAuth, type PrivyUser } from './privyAuth';

export type AuthProvider = 'wallet' | 'privy' | null;

export interface UnifiedUser {
  walletAddress: string;
  displayName?: string;
  avatarUrl?: string;
  email?: string;
}

export interface UnifiedAuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: UnifiedUser | null;
  authProvider: AuthProvider;
  gateStatus: GateStatus | null;
  gateWallet: string | null;
  gateStatusByWallet: Record<string, GateStatus> | null;
  account: {
    accountId: string;
    role: 'user' | 'admin';
    identities: Array<{ type: 'wallet' | 'privy'; providerId: string }>;
  } | null;
  linkedWallets: string[];
  error: string | null;
  logout: () => Promise<void>;
  clearError: () => void;
}

/**
 * Unified auth hook.
 * Wallet-based sign-in has been deprecated; this hook now exposes Privy-backed auth.
 */
export function useAuth(): UnifiedAuthState {
  const privyAuth = usePrivyAuth();

  const linkedWallets =
    privyAuth.account?.identities
      ?.filter((identity) => identity.type === 'wallet')
      .map((identity) => identity.providerId) ?? [];

  if (privyAuth.isAuthenticated && privyAuth.user) {
    return {
      isAuthenticated: true,
      isLoading: privyAuth.isLoading,
      user: normalizePrivyUser(privyAuth.user),
      authProvider: 'privy',
      gateStatus: privyAuth.gateStatus,
      gateWallet: privyAuth.gateWallet,
      gateStatusByWallet: privyAuth.gateStatusByWallet,
      account: privyAuth.account,
      linkedWallets,
      error: privyAuth.error,
      logout: privyAuth.logout,
      clearError: privyAuth.clearError,
    };
  }

  return {
    isAuthenticated: false,
    isLoading: privyAuth.isLoading,
    user: null,
    authProvider: null,
    gateStatus: null,
    gateWallet: null,
    gateStatusByWallet: null,
    account: null,
    linkedWallets: [],
    error: privyAuth.error,
    logout: privyAuth.logout,
    clearError: privyAuth.clearError,
  };
}

function normalizePrivyUser(user: PrivyUser): UnifiedUser {
  return {
    walletAddress: user.walletAddress,
    displayName: user.displayName || user.email,
    avatarUrl: user.avatarUrl,
    email: user.email,
  };
}

// Re-export types for convenience
export type { GateStatus };
