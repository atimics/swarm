import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { useWalletAuth } from './walletAuth';

function resetWalletAuthState() {
  useWalletAuth.setState({
    isAuthenticated: false,
    isLoading: false,
    user: null,
    account: null,
    error: null,
    nftGateError: false,
    nftGateInfo: null,
    gateStatus: null,
    gateWallet: null,
    gateStatusByWallet: null,
  });
}

describe('walletAuth store', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetWalletAuthState();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetWalletAuthState();
  });

  it('recovers cleanly when the user cancels the signature prompt (no wedged loading)', async () => {
    const fetchMock = mock(async (url: any, _init?: any) => {
      const href = typeof url === 'string' ? url : String(url);

      if (href.includes('/auth/challenge')) {
        return new Response(JSON.stringify({ nonce: 'n1', message: 'Sign me' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (href.includes('/auth/verify')) {
        return new Response(JSON.stringify({ error: 'should-not-be-called' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ error: 'unexpected' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const signMessage = mock(async () => {
      throw new Error('User rejected');
    });

    await expect(useWalletAuth.getState().login(signMessage, 'wallet-1')).rejects.toThrow('User rejected');

    const state = useWalletAuth.getState();
    expect(state.isLoading).toBe(false);
    expect(state.isAuthenticated).toBe(false);
    expect(state.user).toBe(null);
    expect(state.error).toContain('Signature was cancelled');
    expect(state.error).toContain('User rejected');

    const calledVerify = (fetchMock.mock.calls as any[]).some((call) => String(call[0]).includes('/auth/verify'));
    expect(calledVerify).toBe(false);
  });
});
