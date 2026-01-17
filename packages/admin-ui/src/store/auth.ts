/**
 * Unified Authentication Store
 * Provides a single interface for Wallet + Privy (and legacy Crossmint)
 */
import { useWalletAuth, type WalletUser, type GateStatus } from './walletAuth';
import { useCrossmintAuth, type CrossmintUser } from './crossmintAuth';
import { usePrivyAuth, type PrivyUser } from './privyAuth';

export type AuthProvider = 'wallet' | 'privy' | 'crossmint' | null;

export interface UnifiedUser {
  walletAddress: string;
  displayName?: string;
  avatarUrl?: string;
  inhabitedAvatarId?: string;
  email?: string; // For email-based providers (Privy/Crossmint)
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
    identities: Array<{ type: 'wallet' | 'privy' | 'crossmint'; providerId: string }>;
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
  const privyAuth = usePrivyAuth();
  const crossmintAuth = useCrossmintAuth();

  // Determine which auth is active.
  // Prefer email-based providers if both are authenticated, since walletAuth may reflect
  // the backend session even when the user signed in via Privy/Crossmint.
  const walletActive = walletAuth.isAuthenticated && walletAuth.user;
  const privyActive = privyAuth.isAuthenticated && privyAuth.user;
  const crossmintActive = crossmintAuth.isAuthenticated && crossmintAuth.user;

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

  // If Crossmint is authenticated, use Crossmint auth
  if (crossmintActive) {
    const account = crossmintAuth.account || walletAuth.account || null;
    const gateWallet = crossmintAuth.gateWallet || walletAuth.gateWallet || null;
    const gateStatusByWallet = crossmintAuth.gateStatusByWallet || walletAuth.gateStatusByWallet || null;
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
      gateWallet,
      gateStatusByWallet,
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
    isLoading: walletAuth.isLoading || privyAuth.isLoading || crossmintAuth.isLoading,
    user: null,
    authProvider: null,
    gateStatus: null,
    gateWallet: null,
    gateStatusByWallet: null,
    account: null,
    linkedWallets: [],
    error: walletAuth.error || privyAuth.error || crossmintAuth.error,
    logout: async () => {
      await walletAuth.logout();
      await privyAuth.logout();
      await crossmintAuth.logout();
    },
    clearError: () => {
      walletAuth.clearError();
      privyAuth.clearError();
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
