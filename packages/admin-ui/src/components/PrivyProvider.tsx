/**
 * Privy Auth Provider
 * Wraps the app with Privy authentication context for email/social login
 * and (optionally) embedded wallet creation.
 */
import { type ReactNode } from 'react';
import { PrivyProvider as PrivyReactProvider } from '@privy-io/react-auth';

const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID || '';

interface PrivyProviderProps {
  children: ReactNode;
}

export function PrivyProvider({ children }: PrivyProviderProps) {
  if (!PRIVY_APP_ID) {
    console.warn('[Privy] No app id configured - Privy auth disabled');
    return <>{children}</>;
  }

  return (
    <PrivyReactProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ['email', 'google', 'twitter'],
        embeddedWallets: {
          solana: {
            createOnLogin: 'users-without-wallets',
          },
        },
      }}
    >
      {children}
    </PrivyReactProvider>
  );
}
