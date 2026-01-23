/**
 * Solana Wallet Provider
 * Wraps the app with Solana wallet adapter context
 * 
 * Note: Phantom, Solflare, and other major wallets auto-register as Standard Wallets
 * via the Wallet Standard. We only need to add adapters for wallets that don't
 * support the standard yet (like Coinbase).
 */
import { useCallback, useMemo, type ReactNode } from 'react';
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { CoinbaseWalletAdapter } from '@solana/wallet-adapter-wallets';
import { humanizeWalletAdapterError, useWalletUi } from '../store/walletUi';

// Import wallet adapter styles
import '@solana/wallet-adapter-react-ui/styles.css';

// Solana RPC endpoint (mainnet-beta)
const SOLANA_RPC = import.meta.env.VITE_SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

interface WalletProviderProps {
  children: ReactNode;
}

export function WalletProvider({ children }: WalletProviderProps) {
  const setWalletError = useWalletUi((s) => s.setWalletError);

  // Only add adapters for wallets that don't support Wallet Standard.
  // Phantom, Solflare, etc. auto-register via Wallet Standard.
  const wallets = useMemo(
    () => [new CoinbaseWalletAdapter()],
    []
  );

  const onError = useCallback(
    (error: unknown) => {
      console.error('[WalletProvider] Wallet error:', error);
      setWalletError(humanizeWalletAdapterError(error));
    },
    [setWalletError]
  );

  return (
    <ConnectionProvider endpoint={SOLANA_RPC}>
      <SolanaWalletProvider wallets={wallets} onError={onError} autoConnect={false}>
        <WalletModalProvider>
          {children}
        </WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}
