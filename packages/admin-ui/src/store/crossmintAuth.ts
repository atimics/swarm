/**
 * Crossmint Authentication Store
 * Manages Crossmint email/social login and session sync with backend
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const API_BASE = import.meta.env?.VITE_API_URL ?? process.env.VITE_API_URL ?? '';

export interface CrossmintUser {
  id: string;
  email?: string;
  walletAddress: string;
  displayName?: string;
  avatarUrl?: string;
  inhabitedAvatarId?: string;
}

export interface AccountSummary {
  accountId: string;
  role: 'user' | 'admin';
  identities: Array<{ type: 'wallet' | 'crossmint'; providerId: string }>;
}

export interface GateStatus {
  nftsHeld: number;
  avatarsCreated: number;
  availableSlots: number;
  canCreate: boolean;
  canAbandon: boolean;
  ownedNFTs?: Array<{ id: string; name: string; image?: string }>;
}

interface CrossmintAuthState {
  // Auth state
  isAuthenticated: boolean;
  isLoading: boolean;
  user: CrossmintUser | null;
  account: AccountSummary | null;
  gateWallet: string | null;
  gateStatusByWallet: Record<string, GateStatus> | null;
  error: string | null;

  // Gate status (same as wallet auth)
  gateStatus: GateStatus | null;

  // Actions
  syncWithBackend: (crossmintJwt: string, crossmintUser: {
    id: string;
    email?: string;
    wallet?: { address: string };
  }) => Promise<void>;
  logout: () => Promise<void>;
  resetLocal: () => void;
  clearError: () => void;
  setLoading: (loading: boolean) => void;
}

export const useCrossmintAuth = create<CrossmintAuthState>()(
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

      /**
       * Sync Crossmint auth with backend
       * Creates/updates user record and session based on Crossmint wallet address
       */
      syncWithBackend: async (crossmintJwt, crossmintUser) => {
        // Guard: Require wallet address
        if (!crossmintUser.wallet?.address) {
          console.warn('[CrossmintAuth] Cannot sync: wallet address not available');
          set({ isLoading: false, error: 'Wallet address not available. Please ensure your wallet is set up in Crossmint.' });
          return; // Don't throw - prevents retry loops
        }

        // Guard: Don't sync if already syncing or authenticated
        const state = get();
        if (state.isLoading) {
          console.debug('[CrossmintAuth] Sync already in progress, skipping');
          return;
        }
        if (state.isAuthenticated && state.user?.walletAddress === crossmintUser.wallet.address) {
          console.debug('[CrossmintAuth] Already authenticated with this wallet');
          return;
        }

        set({ isLoading: true, error: null });
        try {
          // Verify with our backend and create session
          const response = await fetch(`${API_BASE}/auth/crossmint/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jwt: crossmintJwt,
              userId: crossmintUser.id,
              email: crossmintUser.email,
              walletAddress: crossmintUser.wallet.address,
            }),
            credentials: 'include',
          });

          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Failed to verify with backend');
          }

          const data = await response.json();

          if (data.success && data.user) {
            set({
              isAuthenticated: true,
              user: {
                id: crossmintUser.id,
                email: crossmintUser.email,
                walletAddress: data.user.walletAddress,
                displayName: data.user.displayName || crossmintUser.email,
                avatarUrl: data.user.avatarUrl,
                inhabitedAvatarId: data.user.inhabitedAvatarId,
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
          console.error('[CrossmintAuth] Sync error:', error);
          set({
            isAuthenticated: false,
            user: null,
            account: null,
            gateWallet: null,
            gateStatusByWallet: null,
            isLoading: false,
            error: error instanceof Error ? error.message : 'Authentication failed',
          });
          // Don't re-throw - prevents retry loops from callers
        }
      },

      /**
       * Logout from backend session
       */
      logout: async () => {
        set({ isLoading: true });
        try {
          await fetch(`${API_BASE}/auth/logout`, {
            method: 'POST',
            credentials: 'include',
          });
        } catch (error) {
          console.error('[CrossmintAuth] Logout error:', error);
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
      setLoading: (loading) => set({ isLoading: loading }),
    }),
    {
      name: 'crossmint-auth',
      partialize: (state) => ({
        isAuthenticated: state.isAuthenticated,
        user: state.user,
      }),
    }
  )
);
