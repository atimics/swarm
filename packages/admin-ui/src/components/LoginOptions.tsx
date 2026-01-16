/**
 * Login Options Component
 * Provides both Crossmint (email/social) and native wallet login options
 */
import { useCallback, useEffect, useRef } from 'react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useAuth as useCrossmintAuthHook, useWallet as useCrossmintWallet } from '@crossmint/client-sdk-react-ui';
import { useWalletAuth } from '../store/walletAuth';
import { useCrossmintAuth } from '../store/crossmintAuth';

interface LoginOptionsProps {
  className?: string;
  variant?: 'full' | 'compact';
}

export function LoginOptions({ className = '', variant = 'full' }: LoginOptionsProps) {
  const { setVisible } = useWalletModal();
  const walletAuth = useWalletAuth();
  const crossmintAuth = useCrossmintAuth();

  // Crossmint SDK hooks
  const { login: crossmintLogin, user: crossmintUser, jwt, status } = useCrossmintAuthHook();
  const { wallet: crossmintWallet } = useCrossmintWallet();

  // Extract wallet address upfront to ensure stable dependency
  const walletAddress = crossmintWallet?.address;

  // Check if Crossmint SDK is loading or waiting for wallet
  const crossmintIsLoading = status === 'in-progress';
  // Also consider "logged in but waiting for wallet" as loading state
  const isWaitingForWallet = status === 'logged-in' && crossmintUser && !walletAddress;
  const isLoading = walletAuth.isLoading || crossmintAuth.isLoading || crossmintIsLoading || isWaitingForWallet;

  // Track sync attempts to prevent infinite loops
  const syncAttemptedRef = useRef(false);
  const lastJwtRef = useRef<string | null>(null);
  const lastWalletAddressRef = useRef<string | null>(null);

  // When Crossmint auth completes with a wallet, sync with our backend
  useEffect(() => {
    const isLoggedIn = status === 'logged-in';
    const hasWallet = !!walletAddress;
    const isNewJwt = jwt !== lastJwtRef.current;
    const isNewWallet = walletAddress && walletAddress !== lastWalletAddressRef.current;

    console.log('[LoginOptions] Auth effect triggered:', {
      status,
      hasUser: !!crossmintUser,
      userEmail: crossmintUser?.email,
      hasJwt: !!jwt,
      walletAddress,
      hasWallet,
      isAuthenticated: crossmintAuth.isAuthenticated,
      syncAttempted: syncAttemptedRef.current,
      isNewJwt,
      isNewWallet,
      lastWallet: lastWalletAddressRef.current,
    });

    // Only sync if:
    // 1. User is logged in with a wallet address
    // 2. We haven't already synced this JWT/wallet combo
    // 3. We're not already authenticated
    if (isLoggedIn && crossmintUser && jwt && hasWallet && !crossmintAuth.isAuthenticated && (!syncAttemptedRef.current || isNewJwt || isNewWallet)) {
      console.log('[LoginOptions] ✅ Starting backend sync with wallet:', walletAddress);
      syncAttemptedRef.current = true;
      lastJwtRef.current = jwt;
      lastWalletAddressRef.current = walletAddress;
      // Pass wallet address from the wallet hook
      crossmintAuth.syncWithBackend(jwt, {
        ...crossmintUser,
        wallet: { address: walletAddress },
      }).catch((error) => {
        console.error('[LoginOptions] ❌ Sync failed:', error);
        // Reset sync attempted so user can retry
        syncAttemptedRef.current = false;
      });
    } else if (isLoggedIn && !hasWallet) {
      console.warn('[LoginOptions] ⏳ Crossmint user logged in but wallet not yet created');
    } else if (isLoggedIn && hasWallet && crossmintAuth.isAuthenticated) {
      console.log('[LoginOptions] ✓ Already authenticated, skipping sync');
    } else if (isLoggedIn && hasWallet && syncAttemptedRef.current && !isNewJwt && !isNewWallet) {
      console.log('[LoginOptions] ⏸ Sync already attempted for this wallet/jwt combo');
    }
  }, [status, crossmintUser, walletAddress, jwt, crossmintAuth.isAuthenticated]);

  const handleWalletConnect = useCallback(() => {
    walletAuth.clearError();
    setVisible(true);
  }, [setVisible, walletAuth]);

  const handleCrossmintLogin = useCallback(async () => {
    crossmintAuth.clearError();
    
    // If Crossmint SDK already has user logged in but our backend sync hasn't happened,
    // trigger the sync directly instead of calling login() which will error
    if (status === 'logged-in' && jwt && crossmintUser && walletAddress && !crossmintAuth.isAuthenticated) {
      console.log('[LoginOptions] SDK already logged in, triggering backend sync');
      crossmintAuth.setLoading(true);
      try {
        await crossmintAuth.syncWithBackend(jwt, {
          ...crossmintUser,
          wallet: { address: walletAddress },
        });
      } catch (error) {
        console.error('[LoginOptions] Backend sync error:', error);
      } finally {
        crossmintAuth.setLoading(false);
      }
      return;
    }
    
    // Otherwise, initiate normal login flow
    crossmintAuth.setLoading(true);
    try {
      await crossmintLogin();
    } catch (error) {
      console.error('[LoginOptions] Crossmint login error:', error);
    } finally {
      crossmintAuth.setLoading(false);
    }
  }, [crossmintLogin, crossmintAuth, status, jwt, crossmintUser, walletAddress]);

  if (variant === 'compact') {
    return (
      <div className={`flex flex-col gap-2 ${className}`}>
        <button
          onClick={handleCrossmintLogin}
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
      {/* Primary: Email/Social login via Crossmint */}
      <button
        onClick={handleCrossmintLogin}
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
        Sign in with Google, Twitter, Farcaster, or email
      </p>

      {/* Error display */}
      {(walletAuth.error || crossmintAuth.error) && (
        <p className="text-xs text-red-400 text-center">
          {walletAuth.error || crossmintAuth.error}
        </p>
      )}
    </div>
  );
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
