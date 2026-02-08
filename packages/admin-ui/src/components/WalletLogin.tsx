/**
 * Wallet Login Button
 * Handles Solana wallet connection and authentication
 * Also supports Privy auth users in the authenticated display
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useUnifiedWalletContext } from '@jup-ag/wallet-adapter';
import { usePrivy } from '@privy-io/react-auth';
import { useWalletAuth } from '../store/walletAuth';
import { usePrivyAuth } from '../store/privyAuth';
import { useAuth } from '../store/auth';
import { decideWalletConnectionDecision } from '../auth/wallet-connection';
import { formatAddress as formatWalletAddress, getLinkedWalletDisplay } from '../auth/linked-wallets';
import { signMessageWithFallback, signWalletLinkMessage, type PhantomProvider } from '../auth/wallet-linking';
import { humanizeApiUnreachable, humanizeWalletSignatureError } from '../auth/wallet-errors';
import { API_BASE } from '../api/apiBase';
import { useWalletUi } from '../store/walletUi';
import { CopyableAddress } from './CopyableAddress';

interface WalletLoginProps {
  className?: string;
}

function humanizePrivyLinkError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  // Browser fetch/network/CORS failures often surface as a generic TypeError message.
  if (message === 'Failed to fetch' || /networkerror|load failed/i.test(message)) {
    const apiHint = API_BASE ? ` (${API_BASE})` : '';
    return `Couldn't reach the API${apiHint}. If you're on staging, you may need Cloudflare Access for the API subdomain — open the API URL in a new tab, then retry.`;
  }

  return message || 'Failed to link email/social';
}

function humanizeWalletLinkError(error: unknown): string {
  const apiUnreachable = humanizeApiUnreachable(error);
  if (apiUnreachable) return apiUnreachable;

  return humanizeWalletSignatureError(error) || 'Failed to link wallet';
}

function getSolanaWalletAddressFromPrivyUser(privyUser: unknown): string | null {
  const userAny = privyUser as {
    walletAddress?: unknown;
    wallet?: { address?: unknown };
    linkedAccounts?: unknown;
    wallets?: unknown;
  };

  const direct = userAny?.walletAddress ?? userAny?.wallet?.address;
  if (typeof direct === 'string' && direct.length > 0) return direct;

  const accounts: unknown[] = [];
  if (Array.isArray(userAny?.linkedAccounts)) accounts.push(...userAny.linkedAccounts);
  if (Array.isArray(userAny?.wallets)) accounts.push(...userAny.wallets);

  for (const acct of accounts) {
    const acctAny = acct as { chainType?: unknown; chain?: unknown; address?: unknown; publicKey?: unknown };
    const chain = acctAny?.chainType ?? acctAny?.chain;
    const address = acctAny?.address ?? acctAny?.publicKey;
    if ((chain === 'solana' || chain === 'SOLANA') && typeof address === 'string' && address.length > 0) {
      return address;
    }
  }

  return null;
}

export function WalletLogin({ className = '' }: WalletLoginProps) {
  const { publicKey, connected, signMessage, disconnect } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();
  const walletAuth = useWalletAuth();
  const privyAuth = usePrivyAuth();
  const walletUiError = useWalletUi((s) => s.walletError);
  const clearWalletUiError = useWalletUi((s) => s.clearWalletError);

  const {
    login: privyLogin,
    logout: privyLogout,
    authenticated: privyAuthenticated,
    user: privyUser,
    getAccessToken,
  } = usePrivy();

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

  // If user is signed in via an email/social provider and connects a different Phantom wallet,
  // we should not auto-switch accounts. Instead, prompt for an explicit choice.
  const [pendingWalletSwitch, setPendingWalletSwitch] = useState<string | null>(null);
  const [linkingWallet, setLinkingWallet] = useState(false);
  const [linkWalletError, setLinkWalletError] = useState<string | null>(null);
  const [switchingWallet, setSwitchingWallet] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [linkingPrivy, setLinkingPrivy] = useState(false);
  const [linkPrivyError, setLinkPrivyError] = useState<string | null>(null);
  const [pendingWalletConnect, setPendingWalletConnect] = useState(false);
  // Track if wallet connection was initiated specifically for linking (skip the Link/Switch/Ignore prompt)
  const [connectingForLink, setConnectingForLink] = useState(false);

  // Check auth on mount
  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Open wallet modal after Account modal closes (for wallet linking flow)
  useEffect(() => {
    if (pendingWalletConnect && !showAccount) {
      // Use requestAnimationFrame to ensure DOM is fully updated
      const frameId = requestAnimationFrame(() => {
        setPendingWalletConnect(false);
        loginAttemptedRef.current = null;
        clearError();
        clearWalletUiError();
        setShowModal(true);
      });
      return () => cancelAnimationFrame(frameId);
    }
  }, [pendingWalletConnect, showAccount, setShowModal, clearError, clearWalletUiError]);

  // When wallet connects or changes, trigger login flow
  useEffect(() => {
    const phantomProvider = (window as typeof window & { phantom?: { solana?: PhantomProvider } })?.phantom?.solana;
    const publicKeyStr = publicKey ? publicKey.toBase58() : phantomProvider?.publicKey?.toString?.() ?? null;
    const hasWalletAdapterSignMessage = !!signMessage && typeof signMessage === 'function';
    const hasPhantomSignMessage = !!phantomProvider?.signMessage && typeof phantomProvider.signMessage === 'function';
    const hasSignMessage = hasWalletAdapterSignMessage || hasPhantomSignMessage;

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
      if (!hasSignMessage) return;

      const effectiveSignMessage = async (message: Uint8Array) => {
        const { signatureBytes, source } = await signMessageWithFallback({
          message,
          privySignMessage: hasWalletAdapterSignMessage ? signMessage : undefined,
          phantomProvider,
        });
        if (source === 'phantom' && !hasWalletAdapterSignMessage) {
          if (import.meta.env.DEV) console.log('[WalletLogin] Using Phantom provider signMessage fallback');
        }
        return signatureBytes;
      };

      loginAttemptedRef.current = decision.walletAddress;
      login(effectiveSignMessage, decision.walletAddress).catch((err) => {
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
      // Ensure we are signed out of everything first (backend session + Privy + local stores).
      await walletLogout();
      privyAuth.resetLocal();
      await privyLogout();

      // Explicitly sign in as the connected wallet (do not rely on the effect).
      await login(signMessage, pendingWalletSwitch);

      setPendingWalletSwitch(null);
    } catch (err) {
      console.error('[WalletLogin] Switch wallet error:', err);
      setLinkWalletError(err instanceof Error ? err.message : 'Failed to switch wallet');
    } finally {
      setSwitchingWallet(false);
    }
  }, [pendingWalletSwitch, signMessage, walletLogout, privyAuth, privyLogout, login]);


  const handleLinkConnectedWallet = useCallback(async () => {
    if (!pendingWalletSwitch) return;
    const phantomProvider = (window as typeof window & { phantom?: { solana?: PhantomProvider } })?.phantom?.solana;
    if (!signMessage && !phantomProvider?.signMessage) {
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
      const { signatureBase58 } = await signWalletLinkMessage({
        message: messageBytes,
        privySignMessage: signMessage,
        phantomProvider,
      });

      const verifyResponse = await fetch(`${API_BASE}/auth/link/wallet/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          walletAddress: pendingWalletSwitch,
          nonce,
          signature: signatureBase58,
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
      setLinkWalletError(humanizeWalletLinkError(err));
    } finally {
      setLinkingWallet(false);
    }
  }, [pendingWalletSwitch, signMessage, checkAuth]);

  const handleIgnoreConnectedWallet = useCallback(() => {
    setPendingWalletSwitch(null);
    setLinkWalletError(null);
    setConnectingForLink(false);
  }, []);

  // Phantom often requires a direct user gesture to open the signature prompt.
  // So when the user initiated "Connect wallet to link", we do NOT auto-trigger the
  // signing flow from an effect — we just surface the Link button.
  useEffect(() => {
    if (connectingForLink && pendingWalletSwitch) {
      setConnectingForLink(false);
      setLinkWalletError('Wallet connected. Click “Link” to approve the signature in Phantom.');
    }
  }, [connectingForLink, pendingWalletSwitch]);

  // Link Privy identity to an existing wallet account (without switching sessions)
  useEffect(() => {
    if (!linkingPrivy) return;
    if (!privyAuthenticated) return;
    if (!privyUser?.id) return;

    const walletAddress = getSolanaWalletAddressFromPrivyUser(privyUser);

    let cancelled = false;
    const doLink = async () => {
      try {
        const accessToken = await getAccessToken();
        if (!accessToken) throw new Error('Missing Privy access token');

        const response = await fetch(`${API_BASE}/auth/link/privy/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            accessToken,
            userId: privyUser.id,
            email: (privyUser as unknown as { email?: string })?.email,
            walletAddress,
          }),
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to link email/social');
        }

        await walletAuth.checkAuth();
        await privyLogout();
        if (!cancelled) {
          setLinkingPrivy(false);
          setLinkPrivyError(null);
        }
      } catch (e) {
        console.error('[WalletLogin] Link Privy error:', e);
        if (!cancelled) {
          setLinkingPrivy(false);
          setLinkPrivyError(e instanceof Error ? e.message : 'Failed to link email/social');
        }
      }
    };

    doLink();
    return () => {
      cancelled = true;
    };
  }, [linkingPrivy, privyAuthenticated, privyUser, getAccessToken, walletAuth, privyLogout]);

  // Handle connect button click
  const handleConnect = useCallback(() => {
    loginAttemptedRef.current = null; // Allow fresh attempt
    clearError();
    clearWalletUiError();
    setShowModal(true);
  }, [setShowModal, clearError, clearWalletUiError]);

  // Handle connect for wallet linking - closes Account modal first to avoid z-index/focus conflicts
  const handleConnectForLinking = useCallback(() => {
    setShowAccount(false);
    setConnectingForLink(true);
    setPendingWalletConnect(true);
  }, []);

  // Handle disconnect/logout - works for both auth providers
  const handleDisconnect = useCallback(async () => {
    loginAttemptedRef.current = null;
    setPendingWalletSwitch(null);
    setLinkWalletError(null);
    clearWalletUiError();

    // Logout should log out of everything: backend session, Privy, and wallet connection.
    await Promise.allSettled([
      walletLogout(),
      (async () => {
        privyAuth.resetLocal();
        await privyLogout();
      })(),
      disconnect(),
    ]);
  }, [privyAuth, privyLogout, walletLogout, disconnect, clearWalletUiError]);

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
    // For Privy users, show email; for wallet users, show address
    const displayIdentifier = user.email || formatAddress(user.walletAddress);
    const secondaryInfo = user.email
      ? formatAddress(user.walletAddress) // Show truncated wallet for email users
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
            setLinkPrivyError(null);
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
          title={authProvider === 'wallet' ? 'Disconnect wallet' : 'Sign out'}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
        </button>

        {pendingWalletSwitch && authProvider !== 'wallet' && (
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
          <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
            <div
              className="absolute inset-0 bg-black/60"
              onClick={() => setShowAccount(false)}
              aria-hidden="true"
            />
            <div className="relative w-full sm:w-[min(520px,92vw)] max-h-[85dvh] sm:max-h-[80vh] rounded-t-2xl sm:rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-xl overflow-hidden">
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

              <div className="px-4 py-3 space-y-3 overflow-y-auto">
                <div className="text-xs text-[var(--color-text-muted)]">
                  Signed in via{' '}
                  <span className="text-[var(--color-text)] font-medium">
                    {authProvider === 'wallet' ? 'Wallet' : 'Privy'}
                  </span>
                  <span className="text-[var(--color-text-muted)]">
                    {authProvider === 'wallet' ? ' (SIWS)' : ' (email/social)'}
                  </span>
                </div>

                {authProvider !== 'wallet' && user.email && (
                  <div className="rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-3">
                    <div className="text-xs font-medium text-[var(--color-text)]">Identity</div>
                    <div className="mt-2 space-y-2">
                      <div className="flex items-center gap-2">
                        <div className="text-[var(--color-text-muted)]" aria-hidden="true">
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                            <path d="M2.94 6.34A2 2 0 014.5 5.5h11a2 2 0 011.56.84L10 11.5 2.94 6.34z" />
                            <path d="M18 8.12l-7.54 5.1a1 1 0 01-1.12 0L2 8.12V13.5a2 2 0 002 2h12a2 2 0 002-2V8.12z" />
                          </svg>
                        </div>
                        <div className="text-sm text-[var(--color-text)]">{user.email}</div>
                      </div>

                      <div className="flex items-center gap-2">
                        <div className="text-[var(--color-text-muted)]" aria-hidden="true">
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                            <path d="M10 2.5a7.5 7.5 0 00-7.5 7.5v2A3.5 3.5 0 006 15.5h1V8.75a3 3 0 116 0v6.75h1a3.5 3.5 0 003.5-3.5v-2A7.5 7.5 0 0010 2.5z" />
                          </svg>
                        </div>
                        <div className="flex items-baseline gap-2">
                          <div className="text-xs text-[var(--color-text-muted)]">Embedded</div>
                          <CopyableAddress address={user.walletAddress} />
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                <div className="rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-medium text-[var(--color-text)]">Orbs & Access</div>
                      <div className="text-sm text-[var(--color-text)] mt-1">
                        {gateStatus ? `Orbs: ${gateStatus.nftsHeld} • Slots: ${gateStatus.availableSlots}` : 'Unknown'}
                      </div>
                    </div>
                    {gateWallet && (
                      <div className="text-xs text-[var(--color-text-muted)]">
                        Using <CopyableAddress address={gateWallet} className="inline-flex" />
                      </div>
                    )}
                  </div>

                  {sortedGateWallets.length > 0 && (
                    <details className="mt-3">
                      <summary className="cursor-pointer select-none text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                        Wallet breakdown ({sortedGateWallets.length})
                      </summary>
                      <div className="mt-2 space-y-1">
                        {sortedGateWallets.map(([addr, st]) => (
                          <div key={addr} className="flex items-center justify-between text-xs">
                            <CopyableAddress address={addr} className="text-[var(--color-text)]" />
                            <span className="text-[var(--color-text-muted)]">{st.nftsHeld} Orbs • {st.availableSlots} slots</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>

                {(account?.accountId || (authProvider !== 'wallet' && user.walletAddress)) && (
                  <details className="group">
                    <summary className="cursor-pointer select-none text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] inline-flex items-center gap-1">
                      Advanced
                      <svg
                        className="w-3 h-3 transition-transform group-open:rotate-180"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        aria-hidden="true"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </summary>
                    <div className="mt-2 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-3 space-y-2">
                      {account?.accountId && (
                        <div className="text-xs text-[var(--color-text-muted)]">
                          Account ID: <span className="text-[var(--color-text)]">{account.accountId}</span>
                        </div>
                      )}
                      {authProvider !== 'wallet' && user.walletAddress && (
                        <div className="text-xs text-[var(--color-text-muted)] flex items-center gap-2">
                          Embedded wallet:
                          <CopyableAddress address={user.walletAddress} />
                        </div>
                      )}
                    </div>
                  </details>
                )}

                {authProvider !== 'wallet' && (gateStatus?.nftsHeld || 0) === 0 && (
                  <div className="rounded-lg border border-brand-500/30 bg-brand-500/10 p-3">
                    <div className="text-sm font-medium text-[var(--color-text)]">Limited mode</div>
                    <div className="text-xs text-[var(--color-text-secondary)] mt-1">
                      Your embedded wallet has no Orbs. Mint <span className="font-medium">(limited supply)</span>, buy an Orb, or connect a wallet that already holds Orbs and choose <span className="font-medium">Link</span>.
                    </div>

                    {pendingWalletSwitch && (
                      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-2">
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
                        {(linkWalletError || walletUiError) && (
                          <span className="ml-1 text-[11px] text-red-400">
                            {linkWalletError || walletUiError}
                          </span>
                        )}
                      </div>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                      <FaviconLink
                        href="https://www.launchmynft.io/collections/8e55demQ2mUvLDYFvq7D28UartGaK9F9NacQod15eChH/mdMATMxEwub25fM2Ak4o"
                        domain="launchmynft.io"
                        label="Mint (limited supply)"
                      />
                      <FaviconLink
                        href="https://magiceden.io/marketplace/open_rati_nft_mint"
                        domain="magiceden.io"
                        label="Buy on Magic Eden"
                      />
                      <FaviconLink
                        href="https://www.tensor.trade/trade/open_rati_nft_mint"
                        domain="tensor.trade"
                        label="Buy on Tensor"
                      />
                      <button
                        onClick={handleConnectForLinking}
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

                    {!pendingWalletSwitch && walletUiError && (
                      <div className="mt-2 text-xs text-red-400">{walletUiError}</div>
                    )}
                  </div>
                )}

                {authProvider === 'wallet' && (
                  <div className="rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-3">
                    <div className="text-sm font-medium text-[var(--color-text)]">Link email/social</div>
                    <div className="text-xs text-[var(--color-text-secondary)] mt-1">
                      Add Privy (email/social) as another way to sign in to this same account.
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        onClick={async () => {
                          setLinkPrivyError(null);
                          setLinkingPrivy(true);
                          try {
                            await privyLogin();
                          } catch (e) {
                            console.error('[WalletLogin] Privy login for linking failed:', e);
                            setLinkingPrivy(false);
                            setLinkPrivyError(humanizePrivyLinkError(e));
                          }
                        }}
                        disabled={linkingPrivy}
                        className="px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-xs font-medium disabled:opacity-50"
                      >
                        {linkingPrivy ? 'Linking…' : 'Link email/social'}
                      </button>
                      {linkPrivyError && (
                        <span className="text-xs text-red-400">{linkPrivyError}</span>
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
  const phantomProvider = (window as typeof window & { phantom?: { solana?: PhantomProvider } })?.phantom?.solana;
  const hasWalletAdapterSignMessage = !!signMessage && typeof signMessage === 'function';
  const hasPhantomSignMessage = !!phantomProvider?.signMessage && typeof phantomProvider.signMessage === 'function';
  const canWalletSign = hasWalletAdapterSignMessage || hasPhantomSignMessage;

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

      {connected && publicKey && !walletAuth.isLoading && canWalletSign && (
        <button
          onClick={() => {
            const publicKeyStr = publicKey.toBase58();
            const effectiveSign = async (message: Uint8Array) => {
              const { signatureBytes, source } = await signMessageWithFallback({
                message,
                privySignMessage: hasWalletAdapterSignMessage ? signMessage : undefined,
                phantomProvider,
              });
              if (source === 'phantom' && !hasWalletAdapterSignMessage) {
                if (import.meta.env.DEV) console.log('[WalletLogin] Using Phantom provider signMessage fallback');
              }
              return signatureBytes;
            };

            loginAttemptedRef.current = publicKeyStr;
            login(effectiveSign, publicKeyStr).catch((err) => {
              console.error('[WalletLogin] Manual sign-in failed:', err);
            });
          }}
          className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text)] font-medium text-sm transition-all"
        >
          <span>Sign In</span>
        </button>
      )}
      
      {/* Error message */}
      {(error || walletUiError) && (
        <span className="text-xs text-red-400">{error || walletUiError}</span>
      )}
    </div>
  );
}

function FaviconLink({ href, domain, label }: { href: string; domain: string; label: string }) {
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-2 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)] underline-offset-4 hover:underline"
    >
      <img
        src={faviconUrl}
        alt=""
        className="h-4 w-4 rounded-sm"
        loading="lazy"
        referrerPolicy="no-referrer"
      />
      <span>{label}</span>
      <svg className="h-3.5 w-3.5 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path strokeLinecap="round" strokeLinejoin="round" d="M14 3h7v7" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M10 14L21 3" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 14v7H3V3h7" />
      </svg>
    </a>
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
