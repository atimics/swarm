/**
 * Privy Auth Provider
 * Wraps the app with Privy authentication context for email/social login
 * and (optionally) embedded wallet creation.
 */
import { type ReactNode } from 'react';
import { PrivyProvider as PrivyReactProvider, type PrivyClientConfig } from '@privy-io/react-auth';

const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID || '';

interface PrivyProviderProps {
  children: ReactNode;
}

export function PrivyProvider({ children }: PrivyProviderProps) {
  if (!PRIVY_APP_ID) {
    console.error('[Privy] Missing VITE_PRIVY_APP_ID');
    return (
      <div className="min-h-screen bg-[#0b0614] text-white flex items-center justify-center p-6">
        <div className="w-full max-w-xl rounded-2xl border border-white/10 bg-white/5 p-6">
          <h1 className="text-xl font-semibold">Privy is not configured</h1>
          <p className="mt-3 text-sm text-white/70">
            This app requires a Privy App ID to enable sign-in. Set{' '}
            <span className="font-mono text-white/90">VITE_PRIVY_APP_ID</span> and restart the dev server
            (or rebuild the deployed UI).
          </p>
          <pre className="mt-4 overflow-x-auto rounded-xl bg-black/40 p-4 text-xs text-white/80">
VITE_PRIVY_APP_ID=your_privy_app_id
          </pre>
        </div>
      </div>
    );
  }

  return (
    <PrivyReactProvider
      appId={PRIVY_APP_ID}
      config={buildPrivyConfig()}
    >
      {children}
    </PrivyReactProvider>
  );
}

export function buildPrivyConfig(): PrivyClientConfig {
  return {
    loginMethods: ['email', 'google', 'twitter'],
    embeddedWallets: {
      solana: {
        createOnLogin: 'users-without-wallets',
      },
    },
    defaultChain: 'solana',
  };
}
