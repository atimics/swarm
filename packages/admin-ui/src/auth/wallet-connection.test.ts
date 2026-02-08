import { describe, it, expect } from 'bun:test';
import { decideWalletConnectionDecision } from './wallet-connection.js';

describe('wallet connection decision', () => {
  it('attempts auto-login only once per wallet per page load', () => {
    const first = decideWalletConnectionDecision({
      connected: true,
      publicKeyStr: 'wallet-1',
      hasSignMessage: true,
      isLoading: false,
      isAuthenticated: false,
      authProvider: null,
      currentUserWalletAddress: null,
      loginAttemptedWallet: null,
    });

    expect(first).toEqual({ type: 'attemptLogin', walletAddress: 'wallet-1' });

    const second = decideWalletConnectionDecision({
      connected: true,
      publicKeyStr: 'wallet-1',
      hasSignMessage: true,
      isLoading: false,
      isAuthenticated: false,
      authProvider: null,
      currentUserWalletAddress: null,
      loginAttemptedWallet: 'wallet-1',
    });

    expect(second).toEqual({ type: 'noop' });
  });

  it('prompts Link/Switch when Privy is authenticated and a different wallet connects', () => {
    const decision = decideWalletConnectionDecision({
      connected: true,
      publicKeyStr: 'wallet-2',
      hasSignMessage: true,
      isLoading: false,
      isAuthenticated: true,
      authProvider: 'privy',
      currentUserWalletAddress: 'wallet-1',
      loginAttemptedWallet: null,
    });

    expect(decision).toEqual({ type: 'promptSwitch', walletAddress: 'wallet-2' });
  });

  it('logs out and re-auths when wallet-auth session exists but wallet changes', () => {
    const decision = decideWalletConnectionDecision({
      connected: true,
      publicKeyStr: 'wallet-2',
      hasSignMessage: true,
      isLoading: false,
      isAuthenticated: true,
      authProvider: 'wallet',
      currentUserWalletAddress: 'wallet-1',
      loginAttemptedWallet: 'wallet-1',
    });

    expect(decision).toEqual({ type: 'logoutAndReauth' });
  });

  it('resets attempt + pending state on disconnect', () => {
    const decision = decideWalletConnectionDecision({
      connected: false,
      publicKeyStr: null,
      hasSignMessage: true,
      isLoading: false,
      isAuthenticated: false,
      authProvider: null,
      currentUserWalletAddress: null,
      loginAttemptedWallet: 'wallet-1',
    });

    expect(decision).toEqual({ type: 'reset' });
  });

  it('does not re-attempt if a signature prompt was cancelled (no infinite loop)', () => {
    const decision = decideWalletConnectionDecision({
      connected: true,
      publicKeyStr: 'wallet-1',
      hasSignMessage: true,
      isLoading: false,
      isAuthenticated: false,
      authProvider: null,
      currentUserWalletAddress: null,
      loginAttemptedWallet: 'wallet-1',
    });

    expect(decision).toEqual({ type: 'noop' });
  });
});
