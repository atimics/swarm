import { type ReactNode, createContext, useContext, useMemo } from 'react';
import { clusterApiUrl } from '@solana/web3.js';
import type { WalletAdapter } from '@solana/wallet-adapter-base';
import { ConnectionProvider, WalletProvider as SolanaWalletProvider } from '@solana/wallet-adapter-react';
import { WalletModal, WalletModalProvider, useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import '@solana/wallet-adapter-react-ui/styles.css';

type WalletEnvironment = 'mainnet-beta' | 'devnet' | 'testnet';

interface UnifiedWalletConfig {
  autoConnect?: boolean;
  env?: WalletEnvironment;
  metadata?: {
    name?: string;
    description?: string;
    url?: string;
    iconUrls?: string[];
  };
  theme?: 'light' | 'dark';
  lang?: string;
  walletlistExplanation?: {
    href?: string;
  };
  notificationCallback?: {
    onConnect?: (props: { walletName: string; shortAddress: string }) => void;
    onConnecting?: (props: { walletName: string }) => void;
    onDisconnect?: (props: { walletName: string }) => void;
    onNotInstalled?: (props: { walletName: string }) => void;
  };
}

interface UnifiedWalletProviderProps {
  children: ReactNode;
  wallets?: WalletAdapter[];
  config?: UnifiedWalletConfig;
}

interface UnifiedWalletContextValue {
  setShowModal: (show: boolean) => void;
}

const UnifiedWalletContext = createContext<UnifiedWalletContextValue | undefined>(undefined);

function getEndpointForEnv(env: WalletEnvironment): string {
  if (env === 'devnet') return clusterApiUrl('devnet');
  if (env === 'testnet') return clusterApiUrl('testnet');
  return clusterApiUrl('mainnet-beta');
}

function UnifiedWalletContextBridge({ children }: { children: ReactNode }) {
  const { setVisible } = useWalletModal();
  const contextValue = useMemo(
    () => ({
      setShowModal: (show: boolean) => setVisible(show),
    }),
    [setVisible]
  );

  return (
    <UnifiedWalletContext.Provider value={contextValue}>
      {children}
      <WalletModal />
    </UnifiedWalletContext.Provider>
  );
}

export function UnifiedWalletProvider({ children, wallets, config }: UnifiedWalletProviderProps) {
  const env = config?.env ?? 'mainnet-beta';
  const endpoint = useMemo(() => getEndpointForEnv(env), [env]);
  const fallbackWallets = useMemo(() => [new PhantomWalletAdapter()], []);
  const selectedWallets = wallets && wallets.length > 0 ? wallets : fallbackWallets;

  return (
    <ConnectionProvider endpoint={endpoint}>
      <SolanaWalletProvider wallets={selectedWallets} autoConnect={Boolean(config?.autoConnect)}>
        <WalletModalProvider>
          <UnifiedWalletContextBridge>{children}</UnifiedWalletContextBridge>
        </WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}

export function useUnifiedWalletContext(): UnifiedWalletContextValue {
  const context = useContext(UnifiedWalletContext);
  if (!context) {
    throw new Error('useUnifiedWalletContext must be used within UnifiedWalletProvider');
  }
  return context;
}
