/**
 * Privy Authentication Store
 * Manages Privy email/social login and session sync with backend.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { API_BASE } from '../api/apiBase';
import type { GateStatus } from './gateStatus';

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string; message?: string };
    return data.error || data.message || response.statusText || `Request failed (${response.status})`;
  } catch {
    try {
      const text = await response.text();
      return text || response.statusText || `Request failed (${response.status})`;
    } catch {
      return response.statusText || `Request failed (${response.status})`;
    }
  }
}

export interface PrivyUser {
  id: string;
  email?: string;
  walletAddress: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface AccountSummary {
  accountId: string;
  role: 'user' | 'admin';
  identities: Array<{ type: 'wallet' | 'privy'; providerId: string }>;
}

interface PrivyAuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: PrivyUser | null;
  account: AccountSummary | null;
  gateWallet: string | null;
  gateStatusByWallet: Record<string, GateStatus> | null;
  error: string | null;
  gateStatus: GateStatus | null;

  syncWithBackend: (accessToken: string, privyUser: {
    id: string;
    email?: string;
    walletAddress?: string;
  }) => Promise<void>;

  logout: () => Promise<void>;
  resetLocal: () => void;
  clearError: () => void;
  setError: (error: string | null) => void;
  setLoading: (loading: boolean) => void;
}

export const usePrivyAuth = create<PrivyAuthState>()(
  persist(
    (set, get) => ({
      isAuthenticated: false,
      isLoading: false,
      user: null,
      account: null,
      gateWallet: null,
      gateStatusByWallet: null,
      error: null,
      gateStatus: null,

      syncWithBackend: async (accessToken, privyUser) => {
        const walletAddress = privyUser.walletAddress;
        if (!walletAddress) {
          console.warn('[PrivyAuth] Wallet address not available yet; skipping backend sync');
          return;
        }

        const state = get();
        if (state.isLoading) return;
        if (state.isAuthenticated && state.user?.walletAddress === walletAddress) return;

        set({ isLoading: true, error: null });
        try {
          const response = await fetch(`${API_BASE}/auth/privy/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              accessToken,
              userId: privyUser.id,
              email: privyUser.email,
              walletAddress,
            }),
            credentials: 'include',
          });

          if (!response.ok) {
            const message = await readErrorMessage(response);
            throw new Error(message || 'Failed to verify with backend');
          }

          const data = await response.json();
          if (data.success && data.user) {
            set({
              isAuthenticated: true,
              user: {
                id: privyUser.id,
                email: privyUser.email,
                walletAddress: data.user.walletAddress,
                displayName: data.user.displayName || privyUser.email,
                avatarUrl: data.user.avatarUrl,
              },
              account: data.account || null,
              gateWallet: data.gateWallet || null,
              gateStatusByWallet: data.gateStatusByWallet || null,
              gateStatus: data.gateStatus || null,
              isLoading: false,
            });
          } else {
            throw new Error('Backend verification failed');
          }
        } catch (error) {
          console.error('[PrivyAuth] Sync error:', error);
          set({
            isAuthenticated: false,
            user: null,
            account: null,
            gateWallet: null,
            gateStatusByWallet: null,
            gateStatus: null,
            isLoading: false,
            error: error instanceof Error ? error.message : 'Authentication failed',
          });
        }
      },

      logout: async () => {
        set({ isLoading: true });
        try {
          await fetch(`${API_BASE}/auth/logout`, {
            method: 'POST',
            credentials: 'include',
          });
        } catch (error) {
          console.error('[PrivyAuth] Logout error:', error);
        } finally {
          set({
            isAuthenticated: false,
            user: null,
            account: null,
            gateWallet: null,
            gateStatusByWallet: null,
            gateStatus: null,
            isLoading: false,
            error: null,
          });
        }
      },

      resetLocal: () => {
        set({
          isAuthenticated: false,
          user: null,
          account: null,
          gateWallet: null,
          gateStatusByWallet: null,
          gateStatus: null,
          isLoading: false,
          error: null,
        });
      },

      clearError: () => set({ error: null }),
      setError: (error) => set({ error }),
      setLoading: (loading) => set({ isLoading: loading }),
    }),
    {
      name: 'privy-auth',
      partialize: (state) => ({
        isAuthenticated: state.isAuthenticated,
        user: state.user,
        account: state.account,
        gateWallet: state.gateWallet,
        gateStatusByWallet: state.gateStatusByWallet,
        gateStatus: state.gateStatus,
      }),
    }
  )
);
