import { describe, it, expect, mock } from 'bun:test';
import { signMessageWithFallback, signWalletLinkMessage } from './wallet-linking.js';

const encoder = new TextEncoder();

describe('wallet linking message signing', () => {
  it('signMessageWithFallback uses privy signMessage when available', async () => {
    const privySignMessage = mock(async () => Uint8Array.from([1, 2, 3]));

    const result = await signMessageWithFallback({
      message: encoder.encode('hello'),
      privySignMessage,
    });

    expect(result.source).toBe('privy');
    expect(result.signatureBytes.length).toBeGreaterThan(0);
    expect(privySignMessage).toHaveBeenCalledTimes(1);
  });

  it('signMessageWithFallback falls back to Phantom when privy signMessage fails', async () => {
    const privySignMessage = mock(async () => {
      throw new Error('privy failed');
    });

    const phantomProvider = {
      isConnected: true,
      signMessage: mock(async () => ({ signature: Uint8Array.from([9, 9, 9]) })),
    };

    const result = await signMessageWithFallback({
      message: encoder.encode('hello'),
      privySignMessage,
      phantomProvider,
    });

    expect(result.source).toBe('phantom');
    expect(result.signatureBytes.length).toBeGreaterThan(0);
  });

  it('uses privy signMessage when available', async () => {
    const privySignMessage = mock(async () => Uint8Array.from([1, 2, 3]));

    const result = await signWalletLinkMessage({
      message: encoder.encode('hello'),
      privySignMessage,
    });

    expect(result.source).toBe('privy');
    expect(result.signatureBase58.length).toBeGreaterThan(0);
    expect(privySignMessage).toHaveBeenCalledTimes(1);
  });

  it('falls back to Phantom when privy signMessage fails', async () => {
    const privySignMessage = mock(async () => {
      throw new Error('privy failed');
    });

    const phantomProvider = {
      isConnected: true,
      signMessage: mock(async () => ({ signature: Uint8Array.from([9, 9, 9]) })),
    };

    const result = await signWalletLinkMessage({
      message: encoder.encode('hello'),
      privySignMessage,
      phantomProvider,
    });

    expect(result.source).toBe('phantom');
    expect(result.signatureBase58.length).toBeGreaterThan(0);
  });

  it('throws when no signer is available', async () => {
    await expect(
      signWalletLinkMessage({
        message: encoder.encode('hello'),
      })
    ).rejects.toThrow('Connected wallet does not support message signing');
  });
});
