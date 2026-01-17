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

  if (
    authProvider === 'crossmint' &&
    isAuthenticated &&
    currentUserWalletAddress &&
    currentUserWalletAddress !== publicKeyStr
  ) {
    return { type: 'promptSwitch', walletAddress: publicKeyStr };
  }

  if (isAuthenticated && currentUserWalletAddress && currentUserWalletAddress !== publicKeyStr) {
    return { type: 'logoutAndReauth' };
  }

  if (!isAuthenticated && loginAttemptedWallet !== publicKeyStr) {
    return { type: 'attemptLogin', walletAddress: publicKeyStr };
  }

  return { type: 'noop' };
}
