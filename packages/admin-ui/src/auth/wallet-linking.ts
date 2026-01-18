import bs58 from 'bs58';

export interface PhantomProvider {
  isConnected?: boolean;
  publicKey?: { toString(): string } | null;
  connect?: () => Promise<{ publicKey: { toString(): string } } | void>;
  signMessage?: (message: Uint8Array, display?: string) => Promise<{ signature: Uint8Array }>;
}

export async function signWalletLinkMessage(params: {
  message: Uint8Array;
  privySignMessage?: (message: Uint8Array) => Promise<Uint8Array>;
  phantomProvider?: PhantomProvider | null;
}): Promise<{ signatureBase58: string; source: 'privy' | 'phantom' }> {
  const { message, privySignMessage, phantomProvider } = params;

  if (privySignMessage) {
    try {
      const signatureBytes = await privySignMessage(message);
      if (signatureBytes && signatureBytes.length > 0) {
        return { signatureBase58: bs58.encode(signatureBytes), source: 'privy' };
      }
    } catch {
      // Fall back to Phantom
    }
  }

  const phantom = phantomProvider ?? null;
  if (!phantom?.signMessage) {
    throw new Error('Connected wallet does not support message signing');
  }

  if (!phantom.isConnected && phantom.connect) {
    await phantom.connect();
  }

  const phantomResult = await phantom.signMessage(message, 'utf8');
  if (!phantomResult?.signature || phantomResult.signature.length === 0) {
    throw new Error('Phantom did not return a signature');
  }

  return { signatureBase58: bs58.encode(phantomResult.signature), source: 'phantom' };
}
