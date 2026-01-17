/**
 * Unified Authentication Store
 * Provides a single interface for both Wallet and Crossmint authentication
 */
import { useWalletAuth, type WalletUser, type GateStatus } from './walletAuth';
import { useCrossmintAuth, type CrossmintUser } from './crossmintAuth';

export type AuthProvider = 'wallet' | 'crossmint' | null;

export interface UnifiedUser {
  walletAddress: string;
  displayName?: string;
  avatarUrl?: string;
  inhabitedAvatarId?: string;
  email?: string; // Only for Crossmint users
}

export interface UnifiedAuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: UnifiedUser | null;
  authProvider: AuthProvider;
  gateStatus: GateStatus | null;
  account: {
    accountId: string;
    role: 'user' | 'admin';
    identities: Array<{ type: 'wallet' | 'crossmint'; providerId: string }>;
  } | null;
  linkedWallets: string[];
  error: string | null;
  logout: () => Promise<void>;
  clearError: () => void;
}

/**
 * Unified auth hook that combines wallet and Crossmint authentication
 * Returns whichever auth method is currently active
 */
export function useAuth(): UnifiedAuthState {
  const walletAuth = useWalletAuth();
  const crossmintAuth = useCrossmintAuth();

  // Determine which auth is active.
  // Prefer Crossmint if both are authenticated, since walletAuth may reflect
  // the backend session even when the user signed in via Crossmint.
  const walletActive = walletAuth.isAuthenticated && walletAuth.user;
  const crossmintActive = crossmintAuth.isAuthenticated && crossmintAuth.user;

  // If Crossmint is authenticated, use Crossmint auth
  if (crossmintActive) {
    const account = crossmintAuth.account || walletAuth.account || null;
    const linkedWallets =
      account?.identities
        ?.filter(i => i.type === 'wallet')
        .map(i => i.providerId) ??
      [];
    return {
      isAuthenticated: true,
      isLoading: crossmintAuth.isLoading,
      user: normalizeCrossmintUser(crossmintAuth.user!),
      authProvider: 'crossmint',
      gateStatus: crossmintAuth.gateStatus,
      account,
      linkedWallets,
      error: crossmintAuth.error,
      logout: crossmintAuth.logout,
      clearError: crossmintAuth.clearError,
    };
  }

  // If wallet is authenticated, use wallet auth
  if (walletActive) {
    const account = walletAuth.account || null;
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
    isLoading: walletAuth.isLoading || crossmintAuth.isLoading,
    user: null,
    authProvider: null,
    gateStatus: null,
    account: null,
    linkedWallets: [],
    error: walletAuth.error || crossmintAuth.error,
    logout: async () => {
      await walletAuth.logout();
      await crossmintAuth.logout();
    },
    clearError: () => {
      walletAuth.clearError();
      crossmintAuth.clearError();
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

function normalizeCrossmintUser(user: CrossmintUser): UnifiedUser {
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
