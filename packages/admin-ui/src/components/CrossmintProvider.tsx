/**
 * Crossmint Auth Provider
 * Wraps the app with Crossmint authentication context for email/social login
 */
import { type ReactNode } from 'react';
import {
  CrossmintProvider as CrossmintSDKProvider,
  CrossmintAuthProvider,
} from '@crossmint/client-sdk-react-ui';

// Crossmint project ID from environment
const CROSSMINT_PROJECT_ID = import.meta.env.VITE_CROSSMINT_PROJECT_ID || '';

interface CrossmintProviderProps {
  children: ReactNode;
}

export function CrossmintProvider({ children }: CrossmintProviderProps) {
  // Skip provider if no project ID configured
  if (!CROSSMINT_PROJECT_ID) {
    console.warn('[Crossmint] No project ID configured - Crossmint auth disabled');
    return <>{children}</>;
  }

  return (
    <CrossmintSDKProvider apiKey={CROSSMINT_PROJECT_ID}>
      <CrossmintAuthProvider
        loginMethods={['email', 'google', 'twitter', 'farcaster', 'web3']}
      >
        {children}
      </CrossmintAuthProvider>
    </CrossmintSDKProvider>
  );
}
