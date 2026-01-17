import { useWalletAuth } from '../store/walletAuth';
import { useCrossmintAuth } from '../store/crossmintAuth';
import { usePrivyAuth } from '../store/privyAuth';

/**
 * Bootstraps auth from the backend session.
 *
 * Source of truth: `/auth/me` (walletAuth.checkAuth).
 * If the backend session is not authenticated (or the call fails), clear any
 * persisted email-provider local state so it cannot "resurrect" the UI.
 */
export async function bootstrapAuthFromBackendSession(): Promise<void> {
  try {
    await useWalletAuth.getState().checkAuth();

    const walletState = useWalletAuth.getState();
    if (!walletState.isAuthenticated) {
      useCrossmintAuth.getState().resetLocal();
      usePrivyAuth.getState().resetLocal();
    }
  } catch (err) {
    console.error('[bootstrapAuth] Auth bootstrap failed:', err);
    useCrossmintAuth.getState().resetLocal();
    usePrivyAuth.getState().resetLocal();
  }
}
