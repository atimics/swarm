/**
 * Login Options Component
 * Provides both Privy (email/social) and native wallet login options
 */
import { useCallback, useEffect, useRef } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useWalletAuth } from '../store/walletAuth';
import { usePrivy } from '@privy-io/react-auth';
import { usePrivyAuth } from '../store/privyAuth';
import { useWalletUi } from '../store/walletUi';

interface LoginOptionsProps {
  className?: string;
  variant?: 'full' | 'compact';
}

export function LoginOptions({ className = '', variant = 'full' }: LoginOptionsProps) {
  const { setVisible } = useWalletModal();
  const walletAuth = useWalletAuth();
  const privyAuth = usePrivyAuth();
  const walletError = useWalletUi((s) => s.walletError);
  const clearWalletError = useWalletUi((s) => s.clearWalletError);

  // Solana wallet adapter hooks for Phantom/etc
  const { publicKey, connected, signMessage } = useWallet();

  // Privy SDK hooks
  const { ready, authenticated, user: privyUser, login: privyLogin, getAccessToken } = usePrivy();
  const walletAddress = getSolanaWalletAddressFromPrivyUser(privyUser);

  // If Privy is authenticated but we don't yet have an embedded wallet address, don't block the UI.
  const isWaitingForWallet = authenticated && !!privyUser && !walletAddress;

  const isLoading = walletAuth.isLoading || privyAuth.isLoading;

  // Track sync attempts to prevent infinite loops
  const syncAttemptedRef = useRef(false);
  const lastTokenRef = useRef<string | null>(null);
  const lastWalletAddressRef = useRef<string | null>(null);
  
  // Track Solana wallet login attempts
  const solanaLoginAttemptedRef = useRef<string | null>(null);

  const {
    isLoading: walletAuthIsLoading,
    isAuthenticated: walletAuthIsAuthenticated,
    login: walletAuthLogin,
  } = walletAuth;

  // Handle Solana wallet connection (Phantom, etc.)
  // This triggers when user connects wallet from the modal
  useEffect(() => {
    // Check if signMessage is available
    if (!signMessage || typeof signMessage !== 'function') {
      return;
    }

    if (connected && publicKey && !walletAuthIsLoading && !walletAuthIsAuthenticated) {
      const publicKeyStr = publicKey.toBase58();
      
      // Only attempt login if we haven't already tried for this wallet
      if (solanaLoginAttemptedRef.current !== publicKeyStr) {
        console.log('[LoginOptions] 🔐 Solana wallet connected, triggering login:', publicKeyStr);
        solanaLoginAttemptedRef.current = publicKeyStr;
        walletAuthLogin(signMessage, publicKeyStr).catch((err) => {
          console.error('[LoginOptions] ❌ Solana wallet login failed:', err);
          // Keep ref set to prevent retry loop
        });
      }
    }
    
    // Reset attempt tracker when wallet disconnects
    if (!connected) {
      solanaLoginAttemptedRef.current = null;
    }
  }, [connected, publicKey, signMessage, walletAuthIsLoading, walletAuthIsAuthenticated, walletAuthLogin]);

  // When Privy auth completes, sync with our backend.
  // Don't block on embedded wallet creation: Privy may be authenticated before wallet is ready.
  useEffect(() => {
    if (!ready) return;
    if (!authenticated) return;
    if (!privyUser?.id) return;
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
          id: privyUser.id,
          email: (privyUser as unknown as { email?: string })?.email,
          walletAddress: walletAddress ?? undefined,
        });
      } catch (error) {
        console.error('[LoginOptions] Privy backend sync error:', error);
        syncAttemptedRef.current = false;
      }
    };

    void doSync();
  }, [ready, authenticated, privyUser, getAccessToken, walletAddress, privyAuth]);

  const handleWalletConnect = useCallback(() => {
    solanaLoginAttemptedRef.current = null; // Allow fresh attempt
    walletAuth.clearError();
    clearWalletError();
    setVisible(true);
  }, [setVisible, walletAuth, clearWalletError]);

  const handlePrivyLogin = useCallback(async () => {
    privyAuth.clearError();

    // If Privy is already authenticated but backend sync hasn't happened yet, force sync.
    if (ready && authenticated && privyUser?.id && !privyAuth.isAuthenticated) {
      privyAuth.setLoading(true);
      try {
        const token = await getAccessToken();
        if (token) {
          await privyAuth.syncWithBackend(token, {
            id: privyUser.id,
            email: (privyUser as unknown as { email?: string })?.email,
            walletAddress: getSolanaWalletAddressFromPrivyUser(privyUser) ?? undefined,
          });
        }
      } catch (error) {
        console.error('[LoginOptions] Privy backend sync error:', error);
      } finally {
        privyAuth.setLoading(false);
      }
      return;
    }

    privyAuth.setLoading(true);
    try {
      await privyLogin();
    } catch (error) {
      console.error('[LoginOptions] Privy login error:', error);
      const message = error instanceof Error ? error.message : String(error);
      privyAuth.setError(message || 'Sign-in failed');
    } finally {
      privyAuth.setLoading(false);
    }
  }, [privyAuth, ready, authenticated, privyUser, getAccessToken, privyLogin]);

  if (variant === 'compact') {
    return (
      <div className={`flex flex-col gap-2 ${className}`}>
        <button
          onClick={handlePrivyLogin}
          disabled={isLoading}
          className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-gradient-to-r from-brand-500 to-brand-600 hover:from-brand-600 hover:to-brand-700 text-white font-medium text-sm transition-all shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading ? (
            <LoadingSpinner />
          ) : (
            <>
              <EmailIcon />
              <span>Sign In</span>
            </>
          )}
        </button>
        <button
          onClick={handleWalletConnect}
          disabled={isLoading}
          className="flex items-center justify-center gap-2 px-4 py-2 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
        >
          <WalletIcon className="w-4 h-4" />
          <span>Connect Wallet</span>
        </button>
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-4 ${className}`}>
      {/* Primary: Email/Social login via Privy */}
      <button
        onClick={handlePrivyLogin}
        disabled={isLoading}
        className="flex items-center justify-center gap-3 px-8 py-4 rounded-xl bg-gradient-to-r from-brand-500 to-brand-600 hover:from-brand-600 hover:to-brand-700 text-white font-semibold text-lg transition-all shadow-lg shadow-brand-500/30 hover:shadow-brand-500/50 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isLoading ? (
          <>
            <LoadingSpinner />
            <span>Signing in...</span>
          </>
        ) : (
          <>
            <EmailIcon />
            <span>Sign In with Email</span>
          </>
        )}
      </button>

      {isWaitingForWallet && !isLoading && (
        <p className="text-xs text-[var(--color-text-muted)] text-center">
          Privy is finishing wallet setup in the background.
        </p>
      )}

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-[var(--color-border)]" />
        <span className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider">or</span>
        <div className="flex-1 h-px bg-[var(--color-border)]" />
      </div>

      {/* Secondary: Native wallet login */}
      <button
        onClick={handleWalletConnect}
        disabled={isLoading}
        className="flex items-center justify-center gap-3 px-6 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text)] font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <WalletIcon className="w-5 h-5" />
        <span>Connect Wallet</span>
      </button>

      {/* Social login hint */}
      <p className="text-xs text-[var(--color-text-muted)] text-center">
        Sign in with Google, Twitter, or email
      </p>

      {/* Error display */}
      {(walletAuth.error || privyAuth.error || walletError) && (
        <p className="text-xs text-red-400 text-center">
          {walletAuth.error || privyAuth.error || walletError}
        </p>
      )}
    </div>
  );
}

interface WalletLike {
  address?: string;
  publicKey?: string;
}

interface LinkedAccountLike {
  type?: string;
  address?: string;
}

interface PrivyUserLike {
  wallet?: WalletLike;
  embeddedWallet?: WalletLike;
  wallets?: WalletLike[];
  linkedWallets?: WalletLike[];
  linkedAccounts?: LinkedAccountLike[];
  linked_accounts?: LinkedAccountLike[];
}

function getSolanaWalletAddressFromPrivyUser(user: unknown): string | null {
  if (!user || typeof user !== 'object') return null;
  const privyUser = user as PrivyUserLike;

  const direct =
    privyUser?.wallet?.address ||
    privyUser?.wallet?.publicKey ||
    privyUser?.embeddedWallet?.address ||
    privyUser?.embeddedWallet?.publicKey;
  if (typeof direct === 'string' && direct.length >= 32) return direct;

  const wallets = privyUser?.wallets || privyUser?.linkedWallets;
  if (Array.isArray(wallets)) {
    const first = wallets.find((w) => typeof w?.address === 'string')?.address;
    if (typeof first === 'string' && first.length >= 32) return first;
  }

  const linked = privyUser?.linkedAccounts || privyUser?.linked_accounts;
  if (Array.isArray(linked)) {
    const walletAccount = linked.find((a) => a?.type === 'wallet' && typeof a?.address === 'string');
    if (typeof walletAccount?.address === 'string' && walletAccount.address.length >= 32) {
      return walletAccount.address;
    }
  }

  return null;
}

function LoadingSpinner() {
  return (
    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
  );
}

function EmailIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
    </svg>
  );
}

function WalletIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3" />
    </svg>
  );
}
