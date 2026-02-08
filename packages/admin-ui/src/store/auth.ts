/**
 * Unified Authentication Store
 * Provides a single interface for Wallet + Privy.
 */
import { useWalletAuth, type WalletUser, type GateStatus } from './walletAuth';
import { usePrivyAuth, type PrivyUser } from './privyAuth';

export type AuthProvider = 'wallet' | 'privy' | null;

export interface UnifiedUser {
  walletAddress: string;
  displayName?: string;
  avatarUrl?: string;
  inhabitedAvatarId?: string;
  email?: string; // For email-based providers (Privy)
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
 * Unified auth hook that combines wallet and Privy authentication.
 * Returns whichever auth method is currently active
 */
export function useAuth(): UnifiedAuthState {
  const walletAuth = useWalletAuth();
  const privyAuth = usePrivyAuth();

  // Determine which auth is active.
  // Prefer email-based providers if both are authenticated, since walletAuth may reflect
  // the backend session even when the user signed in via Privy.
  const walletActive = walletAuth.isAuthenticated && walletAuth.user;
  const privyActive = privyAuth.isAuthenticated && privyAuth.user;

  // If Privy is authenticated, use Privy auth
  if (privyActive) {
    const account = privyAuth.account || walletAuth.account || null;
    const gateWallet = privyAuth.gateWallet || walletAuth.gateWallet || null;
    const gateStatusByWallet = privyAuth.gateStatusByWallet || walletAuth.gateStatusByWallet || null;
    const linkedWallets =
      account?.identities
        ?.filter(i => i.type === 'wallet')
        .map(i => i.providerId) ??
      [];
    return {
      isAuthenticated: true,
      isLoading: privyAuth.isLoading,
      user: normalizePrivyUser(privyAuth.user!),
      authProvider: 'privy',
      gateStatus: privyAuth.gateStatus,
      gateWallet,
      gateStatusByWallet,
      account,
      linkedWallets,
      error: privyAuth.error,
      logout: privyAuth.logout,
      clearError: privyAuth.clearError,
    };
  }

  // If wallet is authenticated, use wallet auth
  if (walletActive) {
    const account = walletAuth.account || null;
    const gateWallet = walletAuth.gateWallet || null;
    const gateStatusByWallet = walletAuth.gateStatusByWallet || null;
    const linkedWallets =
      account?.identities
        ?.filter(i => i.type === 'wallet')
        .map(i => i.providerId) ??
      [];
    return {
      isAuthenticated: true,
      isLoading: walletAuth.isLoading,
      user: normalizeWalletUser(walletAuth.user!),
      authProvider: 'wallet',
      gateStatus: walletAuth.gateStatus,
      gateWallet,
      gateStatusByWallet,
      account,
      linkedWallets,
      error: walletAuth.error,
      logout: walletAuth.logout,
      clearError: walletAuth.clearError,
    };
  }

  // Not authenticated
  return {
    isAuthenticated: false,
    isLoading: walletAuth.isLoading || privyAuth.isLoading,
    user: null,
    authProvider: null,
    gateStatus: null,
    gateWallet: null,
    gateStatusByWallet: null,
    account: null,
    linkedWallets: [],
    error: walletAuth.error || privyAuth.error,
    logout: async () => {
      await walletAuth.logout();
      await privyAuth.logout();
    },
    clearError: () => {
      walletAuth.clearError();
      privyAuth.clearError();
    },
  };
}

function normalizeWalletUser(user: WalletUser): UnifiedUser {
  return {
    walletAddress: user.walletAddress,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    inhabitedAvatarId: user.inhabitedAvatarId,
  };
}

function normalizePrivyUser(user: PrivyUser): UnifiedUser {
  return {
    walletAddress: user.walletAddress,
    displayName: user.displayName || user.email,
    avatarUrl: user.avatarUrl,
    inhabitedAvatarId: user.inhabitedAvatarId,
    email: user.email,
  };
}

// Re-export types for convenience
export type { GateStatus };
