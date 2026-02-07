/**
 * Solana Wallet Provider
 * Uses Jupiter's Unified Wallet Kit for better wallet integration UX
 * Built on top of @solana/wallet-adapter-* for compatibility
 *
 * See: https://github.com/TeamRaccoons/Unified-Wallet-Kit
 */
import { type ReactNode, useMemo } from 'react';
import { UnifiedWalletProvider } from '@jup-ag/wallet-adapter';
import { useWalletUi } from '../store/walletUi';

interface WalletProviderProps {
  children: ReactNode;
}

export function WalletProvider({ children }: WalletProviderProps) {
  const setWalletError = useWalletUi((s) => s.setWalletError);

  const notificationCallback = useMemo(
    () => ({
      onConnect: (_props: { walletName: string; shortAddress: string }) => {
        // noop
      },
      onConnecting: (_props: { walletName: string }) => {
        // noop
      },
      onDisconnect: (_props: { walletName: string }) => {
        // noop
      },
      onNotInstalled: (props: { walletName: string }) => {
        setWalletError(`${props.walletName} is not installed. Please install it and try again.`);
      },
    }),
    [setWalletError]
  );

  return (
    <UnifiedWalletProvider
      wallets={[]} // Empty = auto-detect via Wallet Standard (works better with Jupiter's kit)
      config={{
        autoConnect: false,
        env: 'mainnet-beta',
        metadata: {
          name: 'Swarm',
          description: 'Multi-tenant social media avatar platform',
          url: 'https://swarm.rati.chat',
          iconUrls: ['https://swarm.rati.chat/swarm.svg'],
        },
        theme: 'dark',
        lang: 'en',
        walletlistExplanation: {
          href: 'https://station.jup.ag/docs/additional-topics/wallet-list',
        },
        notificationCallback,
      }}
    >
      {children}
    </UnifiedWalletProvider>
  );
}
