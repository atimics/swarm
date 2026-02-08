export type WalletConnectionDecision =
  | { type: 'noop' }
  | { type: 'reset' }
  | { type: 'promptSwitch'; walletAddress: string }
  | { type: 'logoutAndReauth' }
  | { type: 'attemptLogin'; walletAddress: string };

export function decideWalletConnectionDecision(params: {
  connected: boolean;
  publicKeyStr: string | null;
  hasSignMessage: boolean;
  isLoading: boolean;
  isAuthenticated: boolean;
  authProvider: string | null | undefined;
  currentUserWalletAddress: string | null;
  loginAttemptedWallet: string | null;
}): WalletConnectionDecision {
  const {
    connected,
    publicKeyStr,
    hasSignMessage,
    isLoading,
    isAuthenticated,
    authProvider,
    currentUserWalletAddress,
    loginAttemptedWallet,
  } = params;

  if (!connected) return { type: 'reset' };
  if (!hasSignMessage) return { type: 'noop' };
  if (!publicKeyStr) return { type: 'noop' };
  if (isLoading) return { type: 'noop' };

  if (isAuthenticated && currentUserWalletAddress && currentUserWalletAddress !== publicKeyStr) {
    // If the user is authenticated via a non-wallet provider (e.g. Privy)
    // and then connects a different wallet, do not silently log them out.
    // Instead, prompt them to Link or Switch.
    if (authProvider && authProvider !== 'wallet') {
      return { type: 'promptSwitch', walletAddress: publicKeyStr };
    }
    return { type: 'logoutAndReauth' };
  }

  if (!isAuthenticated && loginAttemptedWallet !== publicKeyStr) {
    return { type: 'attemptLogin', walletAddress: publicKeyStr };
  }

  return { type: 'noop' };
}
