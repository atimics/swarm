/**
 * Simple Privy Login Button
 * For use in public pages like shared chat where we only want Privy auth
 */
import { useCallback, useEffect, useRef } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { useAuth } from '../store/auth';
import { usePrivyAuth } from '../store/privyAuth';

interface PrivyLoginButtonProps {
  className?: string;
}

/**
 * Extract Solana wallet address from Privy user object
 */
function getSolanaWalletAddressFromPrivyUser(user: unknown): string | null {
  if (!user || typeof user !== 'object') return null;
  const typedUser = user as {
    wallet?: { address?: string; chainType?: string };
    linkedAccounts?: Array<{ type: string; address?: string; chainType?: string }>;
  };

  // Check embedded wallet first
  if (typedUser.wallet?.address && typedUser.wallet?.chainType === 'solana') {
    return typedUser.wallet.address;
  }

  // Check linked accounts
  if (Array.isArray(typedUser.linkedAccounts)) {
    const solanaWallet = typedUser.linkedAccounts.find(
      (acc) => acc.type === 'wallet' && acc.chainType === 'solana' && acc.address
    );
    if (solanaWallet?.address) return solanaWallet.address;
  }

  return null;
}

export function PrivyLoginButton({ className = '' }: PrivyLoginButtonProps) {
  const { login, logout: privyLogout, ready, authenticated, user: privyUser, getAccessToken } = usePrivy();
  const { isAuthenticated, isLoading, user, logout: authLogout } = useAuth();
  const privyAuth = usePrivyAuth();

  // Track sync attempts to prevent infinite loops
  const syncAttemptedRef = useRef(false);
  const lastTokenRef = useRef<string | null>(null);
  const lastWalletAddressRef = useRef<string | null>(null);

  const walletAddress = getSolanaWalletAddressFromPrivyUser(privyUser);

  // Sync Privy auth state with backend when Privy is authenticated but our store isn't
  useEffect(() => {
    if (!ready) return;
    if (!authenticated) return;
    if (!privyUser) return;
    if (privyAuth.isAuthenticated) return;

    const doSync = async () => {
      try {
        const token = await getAccessToken();
        if (!token) return;

        const isNewToken = token !== lastTokenRef.current;
        const isNewWallet = walletAddress && walletAddress !== lastWalletAddressRef.current;
        if (syncAttemptedRef.current && !isNewToken && !isNewWallet) return;

        syncAttemptedRef.current = true;
        lastTokenRef.current = token;
        lastWalletAddressRef.current = walletAddress ?? null;

        await privyAuth.syncWithBackend(token, {
          id: (privyUser as { id: string }).id,
          email: (privyUser as { email?: string })?.email,
          walletAddress: walletAddress ?? undefined,
        });
      } catch (error) {
        console.error('[PrivyLoginButton] Privy backend sync error:', error);
        syncAttemptedRef.current = false;
      }
    };

    void doSync();
  }, [ready, authenticated, privyUser, getAccessToken, walletAddress, privyAuth]);

  const handleLogin = useCallback(async () => {
    // If Privy is already authenticated but backend sync hasn't happened yet, force sync
    if (ready && authenticated && privyUser && !privyAuth.isAuthenticated) {
      privyAuth.setLoading(true);
      try {
        const token = await getAccessToken();
        if (token) {
          await privyAuth.syncWithBackend(token, {
            id: (privyUser as { id: string }).id,
            email: (privyUser as { email?: string })?.email,
            walletAddress: getSolanaWalletAddressFromPrivyUser(privyUser) ?? undefined,
          });
        }
      } catch (error) {
        console.error('[PrivyLoginButton] Privy backend sync error:', error);
      } finally {
        privyAuth.setLoading(false);
      }
      return;
    }

    // Otherwise, trigger Privy login flow
    login();
  }, [login, ready, authenticated, privyUser, privyAuth, getAccessToken]);

  const handleLogout = useCallback(async () => {
    // Logout from both Privy SDK AND clear backend session/store
    await Promise.all([
      privyLogout(),
      authLogout(),
    ]);
    // Force page reload to clear any stale state
    window.location.reload();
  }, [privyLogout, authLogout]);

  // Loading state
  if (isLoading || privyAuth.isLoading) {
    return (
      <button
        className={`flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] ${className}`}
        disabled
      >
        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        <span className="text-sm">Connecting...</span>
      </button>
    );
  }

  // Authenticated state
  if (isAuthenticated && user) {
    const displayName = user.displayName || user.email || `${user.walletAddress.slice(0, 6)}...${user.walletAddress.slice(-4)}`;

    return (
      <div className={`flex items-center gap-3 ${className}`}>
        {/* User avatar */}
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center text-white text-xs font-bold overflow-hidden">
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            displayName[0]?.toUpperCase() || '?'
          )}
        </div>

        {/* User info */}
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-medium text-[var(--color-text)] truncate">
            {displayName}
          </span>
          {user.inhabitedAvatarId && (
            <span className="text-xs text-[var(--color-text-muted)] truncate">
              Inhabiting avatar
            </span>
          )}
        </div>

        {/* Logout button */}
        <button
          onClick={handleLogout}
          className="p-1.5 rounded-lg hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          title="Sign out"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
        </button>
      </div>
    );
  }

  // Not authenticated - show login button
  return (
    <button
      onClick={handleLogin}
      className={`flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-brand-500 to-brand-600 hover:from-brand-600 hover:to-brand-700 text-white font-medium text-sm transition-all shadow-lg shadow-brand-500/25 ${className}`}
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
      </svg>
      <span>Login with Privy</span>
    </button>
  );
}
