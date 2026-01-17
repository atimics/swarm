/**
 * Wallet Login Button
 * Handles Solana wallet connection and authentication
 * Also supports Crossmint auth users in the authenticated display
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useAuth as useCrossmintAuthHook, useWallet as useCrossmintWallet } from '@crossmint/client-sdk-react-ui';
import bs58 from 'bs58';
import { useWalletAuth } from '../store/walletAuth';
import { useCrossmintAuth } from '../store/crossmintAuth';
import { useAuth } from '../store/auth';
import { decideWalletConnectionDecision } from '../auth/wallet-connection';
import { formatAddress as formatWalletAddress, getLinkedWalletDisplay } from '../auth/linked-wallets';

interface WalletLoginProps {
  className?: string;
}

const API_BASE = import.meta.env?.VITE_API_URL ?? process.env.VITE_API_URL ?? '';

export function WalletLogin({ className = '' }: WalletLoginProps) {
  const { publicKey, connected, signMessage, disconnect } = useWallet();
  const { setVisible } = useWalletModal();
  const walletAuth = useWalletAuth();
  const crossmintAuth = useCrossmintAuth();
  const { login: crossmintLogin, logout: crossmintLogout, user: crossmintUser, jwt: crossmintJwt, status: crossmintStatus } = useCrossmintAuthHook();
  const { wallet: crossmintWallet } = useCrossmintWallet();

  // Use unified auth for display
  const {
    isAuthenticated,
    isLoading,
    user,
    authProvider,
    gateStatus,
    gateWallet,
    gateStatusByWallet,
    account,
    linkedWallets,
    error,
    clearError,
  } = useAuth();

  // Destructure wallet-specific methods
  const { login, logout: walletLogout, checkAuth } = walletAuth;

  // Track if we've attempted login for current wallet connection
  // Prevents infinite loop when login fails
  const loginAttemptedRef = useRef<string | null>(null);

  // If user is signed in via Crossmint and connects a different Phantom wallet,
  // we should not auto-switch accounts. Instead, prompt for an explicit choice.
  const [pendingWalletSwitch, setPendingWalletSwitch] = useState<string | null>(null);
  const [linkingWallet, setLinkingWallet] = useState(false);
  const [linkWalletError, setLinkWalletError] = useState<string | null>(null);
  const [switchingWallet, setSwitchingWallet] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [linkingCrossmint, setLinkingCrossmint] = useState(false);
  const [linkCrossmintError, setLinkCrossmintError] = useState<string | null>(null);

  // Check auth on mount
  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // When wallet connects or changes, trigger login flow
  useEffect(() => {
    const publicKeyStr = publicKey ? publicKey.toBase58() : null;
    const hasSignMessage = !!signMessage && typeof signMessage === 'function';

    const decision = decideWalletConnectionDecision({
      connected,
      publicKeyStr,
      hasSignMessage,
      isLoading,
      isAuthenticated,
      authProvider,
      currentUserWalletAddress: user?.walletAddress ?? null,
      loginAttemptedWallet: loginAttemptedRef.current,
    });

    if (decision.type === 'reset') {
      loginAttemptedRef.current = null;
      setPendingWalletSwitch(null);
      return;
    }

    if (decision.type === 'promptSwitch') {
      setPendingWalletSwitch(decision.walletAddress);
      return;
    }

    if (decision.type === 'logoutAndReauth') {
      console.log('[WalletLogin] Wallet changed, re-authenticating...');
      loginAttemptedRef.current = null;
      walletLogout().then(() => {
        // After logout, the next render will trigger login with new wallet
      });
      return;
    }

    if (decision.type === 'attemptLogin') {
      if (!hasSignMessage || !signMessage || typeof signMessage !== 'function') return;

      loginAttemptedRef.current = decision.walletAddress;
      login(signMessage, decision.walletAddress).catch((err) => {
        console.error('Login failed:', err);
        // Keep loginAttemptedRef set to prevent retry loop
      });
    }
  }, [connected, publicKey, signMessage, isAuthenticated, isLoading, login, walletLogout, user, authProvider]);

  const handleSwitchToConnectedWallet = useCallback(async () => {
    if (!pendingWalletSwitch) return;
    if (!signMessage || typeof signMessage !== 'function') {
      setLinkWalletError('Connected wallet does not support message signing');
      return;
    }

    setSwitchingWallet(true);
    setLinkWalletError(null);
    loginAttemptedRef.current = pendingWalletSwitch;

    try {
      // Ensure we are signed out of everything first (backend session + Crossmint SDK + local stores).
      await walletLogout();
      crossmintAuth.resetLocal();
      await crossmintLogout();

      // Explicitly sign in as the connected wallet (do not rely on the effect).
      await login(signMessage, pendingWalletSwitch);

      setPendingWalletSwitch(null);
    } catch (err) {
      console.error('[WalletLogin] Switch wallet error:', err);
      setLinkWalletError(err instanceof Error ? err.message : 'Failed to switch wallet');
    } finally {
      setSwitchingWallet(false);
    }
  }, [pendingWalletSwitch, signMessage, walletLogout, crossmintAuth, crossmintLogout, login]);

  const handleLinkConnectedWallet = useCallback(async () => {
    if (!pendingWalletSwitch) return;
    if (!signMessage || typeof signMessage !== 'function') {
      setLinkWalletError('Connected wallet does not support message signing');
      return;
    }

    setLinkingWallet(true);
    setLinkWalletError(null);

    try {
      const challengeResponse = await fetch(`${API_BASE}/auth/link/wallet/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ walletAddress: pendingWalletSwitch }),
      });

      if (!challengeResponse.ok) {
        const err = await challengeResponse.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to create link challenge');
      }

      const { nonce, message } = await challengeResponse.json();

      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = await signMessage(messageBytes);
      const signature = bs58.encode(signatureBytes);

      const verifyResponse = await fetch(`${API_BASE}/auth/link/wallet/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          walletAddress: pendingWalletSwitch,
          nonce,
          signature,
        }),
      });

      if (!verifyResponse.ok) {
        const err = await verifyResponse.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to link wallet');
      }

      // Refresh backend-derived session state.
      await checkAuth();

      setPendingWalletSwitch(null);
    } catch (err) {
      console.error('[WalletLogin] Link wallet error:', err);
      setLinkWalletError(err instanceof Error ? err.message : 'Failed to link wallet');
    } finally {
      setLinkingWallet(false);
    }
  }, [pendingWalletSwitch, signMessage, checkAuth]);

  const handleIgnoreConnectedWallet = useCallback(() => {
    setPendingWalletSwitch(null);
    setLinkWalletError(null);
  }, []);

  // Link Crossmint identity to an existing wallet account (without switching sessions)
  useEffect(() => {
    if (!linkingCrossmint) return;
    if (crossmintStatus !== 'logged-in') return;
    if (!crossmintJwt || !crossmintUser?.id) return;

    const walletAddress = crossmintWallet?.address;
    if (!walletAddress) return;

    let cancelled = false;
    const doLink = async () => {
      try {
        const response = await fetch(`${API_BASE}/auth/link/crossmint/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            jwt: crossmintJwt,
            userId: crossmintUser.id,
            email: crossmintUser.email,
            walletAddress,
          }),
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to link email/social');
        }

        await walletAuth.checkAuth();
        await crossmintLogout();
        if (!cancelled) {
          setLinkingCrossmint(false);
          setLinkCrossmintError(null);
        }
      } catch (e) {
        console.error('[WalletLogin] Link Crossmint error:', e);
        if (!cancelled) {
          setLinkingCrossmint(false);
          setLinkCrossmintError(e instanceof Error ? e.message : 'Failed to link email/social');
        }
      }
    };

    doLink();
    return () => {
      cancelled = true;
    };
  }, [linkingCrossmint, crossmintStatus, crossmintJwt, crossmintUser, crossmintWallet, walletAuth, crossmintLogout]);

  // Handle connect button click
  const handleConnect = useCallback(() => {
    loginAttemptedRef.current = null; // Allow fresh attempt
    clearError();
    setVisible(true);
  }, [setVisible, clearError]);

  // Handle disconnect/logout - works for both auth providers
  const handleDisconnect = useCallback(async () => {
    loginAttemptedRef.current = null;
    setPendingWalletSwitch(null);
    setLinkWalletError(null);

    // Logout should log out of everything: backend session, Crossmint SDK, and wallet connection.
    await Promise.allSettled([
      walletLogout(),
      (async () => {
        crossmintAuth.resetLocal();
        await crossmintLogout();
      })(),
      disconnect(),
    ]);
  }, [crossmintAuth, crossmintLogout, walletLogout, disconnect]);

  // Format wallet address for display
  const formatAddress = formatWalletAddress;

  const sortedGateWallets = Object.entries(gateStatusByWallet || {})
    .sort((a, b) => (b[1]?.nftsHeld || 0) - (a[1]?.nftsHeld || 0));

  // Loading state
  if (isLoading) {
    return (
      <button
        className={`flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] ${className}`}
        disabled
      >
        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        <span className="text-sm">Connecting...</span>
      </button>
    );
  }

  // Authenticated state
  if (isAuthenticated && user) {
    // For Crossmint users, show email; for wallet users, show address
    const displayIdentifier = user.email || formatAddress(user.walletAddress);
    const secondaryInfo = user.email
      ? formatAddress(user.walletAddress) // Show truncated wallet for Crossmint users
      : undefined; // Don't show wallet twice for wallet users

    const { labels: linkedWalletLabels, overflow: linkedWalletOverflow } = getLinkedWalletDisplay({
      linkedWallets,
      primaryWallet: user.walletAddress,
      maxLabels: 2,
    });

    return (
      <div className={`flex items-center gap-2 ${className}`}>
        {/* User avatar or ghost icon */}
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center text-white text-xs font-bold">
          {user.displayName?.[0]?.toUpperCase() || user.email?.[0]?.toUpperCase() || '👻'}
        </div>

        {/* User info */}
        <div className="flex flex-col">
          <span className="text-xs font-medium text-[var(--color-text)]">
            {user.displayName || displayIdentifier}
          </span>
          {(user.displayName || secondaryInfo) && (
            <span className="text-xs text-[var(--color-text-muted)]">
              {user.displayName ? displayIdentifier : secondaryInfo}
            </span>
          )}

          {linkedWallets.length > 1 && (
            <span className="text-[11px] text-[var(--color-text-muted)]">
              Linked wallets: {linkedWalletLabels.join(', ')}
              {linkedWalletOverflow > 0 ? ` +${linkedWalletOverflow}` : ''}
            </span>
          )}
        </div>

        {/* Account button */}
        <button
          onClick={() => {
            setShowAccount(true);
            setLinkCrossmintError(null);
          }}
          className="p-1.5 rounded-lg hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          title="Account"
          aria-label="Account"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.5a7.5 7.5 0 017.5 7.5v2.25a3 3 0 01-3 3H7.5a3 3 0 01-3-3V12A7.5 7.5 0 0112 4.5z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 20.25h4.5" />
          </svg>
        </button>

        {/* Disconnect button */}
        <button
          onClick={handleDisconnect}
          className="p-1.5 rounded-lg hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          title={authProvider === 'crossmint' ? 'Sign out' : 'Disconnect wallet'}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
        </button>

        {pendingWalletSwitch && authProvider === 'crossmint' && (
          <div className="ml-2 flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1">
            <span className="text-[11px] text-[var(--color-text-secondary)]">
              Wallet connected: {formatAddress(pendingWalletSwitch)}
            </span>
            <button
              onClick={handleLinkConnectedWallet}
              className="text-[11px] font-medium text-brand-400 hover:text-brand-300 disabled:opacity-50"
              disabled={linkingWallet || switchingWallet}
              title="Link this wallet to your current account"
            >
              {linkingWallet ? 'Linking…' : 'Link'}
            </button>
            <button
              onClick={handleSwitchToConnectedWallet}
              className="text-[11px] font-medium text-brand-400 hover:text-brand-300 disabled:opacity-50"
              disabled={switchingWallet || linkingWallet}
              title="Switch to this wallet account"
            >
              {switchingWallet ? 'Switching…' : 'Switch'}
            </button>
            <button
              onClick={handleIgnoreConnectedWallet}
              className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              title="Keep current sign-in"
            >
              Ignore
            </button>

            {linkWalletError && (
              <span className="ml-2 text-[11px] text-red-400">
                {linkWalletError}
              </span>
            )}
          </div>
        )}

        {showAccount && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div
              className="absolute inset-0 bg-black/60"
              onClick={() => setShowAccount(false)}
              aria-hidden="true"
            />
            <div className="relative w-[min(520px,92vw)] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-xl">
              <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
                <div className="text-sm font-semibold text-[var(--color-text)]">Account</div>
                <button
                  onClick={() => setShowAccount(false)}
                  className="p-1.5 rounded-lg hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  aria-label="Close"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                    <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                  </svg>
                </button>
              </div>

              <div className="px-4 py-3 space-y-3">
                <div className="text-xs text-[var(--color-text-muted)]">
                  Signed in with: <span className="text-[var(--color-text)] font-medium">{authProvider === 'crossmint' ? 'Email/Social (Crossmint)' : 'Wallet (SIWS)'}</span>
                </div>

                {authProvider === 'crossmint' && user.email && (
                  <div className="rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-3">
                    <div className="text-xs text-[var(--color-text-muted)]">Email</div>
                    <div className="text-sm text-[var(--color-text)]">{user.email}</div>
                    <div className="mt-2 text-xs text-[var(--color-text-muted)]">Embedded wallet</div>
                    <div className="text-sm text-[var(--color-text)]">{formatAddress(user.walletAddress)}</div>
                  </div>
                )}

                {account?.accountId && (
                  <div className="text-xs text-[var(--color-text-muted)]">
                    Account ID: <span className="text-[var(--color-text)]">{account.accountId}</span>
                  </div>
                )}

                <div className="rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs text-[var(--color-text-muted)]">Orbs / Gating</div>
                      <div className="text-sm text-[var(--color-text)]">
                        {gateStatus ? `${gateStatus.nftsHeld} Orbs • ${gateStatus.availableSlots} slots` : 'Unknown'}
                      </div>
                    </div>
                    {gateWallet && (
                      <div className="text-xs text-[var(--color-text-muted)]">
                        Using: <span className="text-[var(--color-text)]">{formatAddress(gateWallet)}</span>
                      </div>
                    )}
                  </div>

                  {sortedGateWallets.length > 0 && (
                    <div className="mt-3">
                      <div className="text-xs text-[var(--color-text-muted)] mb-1">Wallets</div>
                      <div className="space-y-1">
                        {sortedGateWallets.map(([addr, st]) => (
                          <div key={addr} className="flex items-center justify-between text-xs">
                            <span className="text-[var(--color-text)]">{formatAddress(addr)}</span>
                            <span className="text-[var(--color-text-muted)]">{st.nftsHeld} Orbs • {st.availableSlots} slots</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {authProvider === 'crossmint' && (gateStatus?.nftsHeld || 0) === 0 && (
                  <div className="rounded-lg border border-brand-500/30 bg-brand-500/10 p-3">
                    <div className="text-sm font-medium text-[var(--color-text)]">Limited mode</div>
                    <div className="text-xs text-[var(--color-text-secondary)] mt-1">
                      Your embedded wallet has no Orbs. To unlock Orb-gated features, connect your existing wallet that holds Orbs and choose <span className="font-medium">Link</span>.
                    </div>
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={handleConnect}
                        className="px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-xs font-medium"
                      >
                        Connect wallet to link
                      </button>
                      <button
                        onClick={() => setShowAccount(false)}
                        className="px-3 py-1.5 rounded-lg bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text)] text-xs"
                      >
                        Got it
                      </button>
                    </div>
                  </div>
                )}

                {authProvider === 'wallet' && (
                  <div className="rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-3">
                    <div className="text-sm font-medium text-[var(--color-text)]">Link email/social</div>
                    <div className="text-xs text-[var(--color-text-secondary)] mt-1">
                      Add Crossmint (email/social) as another way to sign in to this same account.
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        onClick={async () => {
                          setLinkCrossmintError(null);
                          setLinkingCrossmint(true);
                          try {
                            await crossmintLogin();
                          } catch (e) {
                            console.error('[WalletLogin] Crossmint login for linking failed:', e);
                            setLinkingCrossmint(false);
                            setLinkCrossmintError(e instanceof Error ? e.message : 'Failed to open Crossmint login');
                          }
                        }}
                        disabled={linkingCrossmint}
                        className="px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-xs font-medium disabled:opacity-50"
                      >
                        {linkingCrossmint ? 'Linking…' : 'Link email/social'}
                      </button>
                      {linkCrossmintError && (
                        <span className="text-xs text-red-400">{linkCrossmintError}</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Not authenticated - show connect button
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <button
        onClick={handleConnect}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gradient-to-r from-brand-500 to-brand-600 hover:from-brand-600 hover:to-brand-700 text-white font-medium text-sm transition-all shadow-lg shadow-brand-500/25"
      >
        {/* Phantom/Solana icon */}
        <svg className="w-4 h-4" viewBox="0 0 128 128" fill="currentColor">
          <circle cx="64" cy="64" r="64" fill="currentColor" opacity="0.2" />
          <path d="M110.5 64c0-25.6-20.9-46.5-46.5-46.5S17.5 38.4 17.5 64s20.9 46.5 46.5 46.5 46.5-20.9 46.5-46.5zm-72.8 0c0-14.5 11.8-26.3 26.3-26.3s26.3 11.8 26.3 26.3-11.8 26.3-26.3 26.3S37.7 78.5 37.7 64z" />
        </svg>
        <span>Connect Wallet</span>
      </button>
      
      {/* Error message */}
      {error && (
        <span className="text-xs text-red-400">{error}</span>
      )}
    </div>
  );
}

/**
 * Ghost icon for unauthenticated users in chat
 */
export function GhostAvatar({ className = '' }: { className?: string }) {
  return (
    <div className={`w-8 h-8 rounded-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] flex items-center justify-center ${className}`}>
      <span className="text-base opacity-50">👻</span>
    </div>
  );
}

/**
 * User avatar (shows avatar avatar if inhabited, ghost if not)
 */
export function UserAvatar({ 
  walletAddress,
  displayName,
  avatarUrl,
  size = 'md',
  className = '',
}: {
  walletAddress?: string;
  displayName?: string;
  avatarUrl?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const sizeClasses = {
    sm: 'w-6 h-6 text-xs',
    md: 'w-8 h-8 text-sm',
    lg: 'w-10 h-10 text-base',
  };

  // No wallet = ghost
  if (!walletAddress) {
    return <GhostAvatar className={className} />;
  }

  // Has avatar URL (inhabited avatar)
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={displayName || 'User'}
        className={`${sizeClasses[size]} rounded-full object-cover ${className}`}
      />
    );
  }

  // Wallet connected but no avatar - show gradient with initial
  const initial = displayName?.[0]?.toUpperCase() || walletAddress.slice(0, 2);
  
  return (
    <div className={`${sizeClasses[size]} rounded-full bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center text-white font-bold ${className}`}>
      {initial}
    </div>
  );
}
