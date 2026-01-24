/**
 * Solana Wallet Provider
 * Wraps the app with Solana wallet adapter context
 *
 * Note: While Phantom and Solflare support Wallet Standard auto-registration,
 * there's a known bug where clicking on them in the modal does nothing.
 * We explicitly add adapters as a workaround.
 * See: https://github.com/anza-xyz/wallet-adapter/issues/1111
 */
import { useCallback, useMemo, type ReactNode } from 'react';
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import {
  CoinbaseWalletAdapter,
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from '@solana/wallet-adapter-wallets';
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

  // Explicitly add wallet adapters as a workaround for Wallet Standard detection issues.
  // See: https://github.com/anza-xyz/wallet-adapter/issues/1111
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
      new CoinbaseWalletAdapter(),
    ],
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
