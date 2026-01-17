import { describe, it, expect } from 'bun:test';
import { getAccountGateStatus } from './account-gate.js';

function gateStatus(availableSlots: number, nftsHeld: number) {
  return {
    nftsHeld,
    avatarsCreated: 0,
    availableSlots,
    canCreate: availableSlots > 0,
    canAbandon: true,
  };
}

describe('account-gate', () => {
  it('returns nulls when account has no linked wallets', async () => {
    const result = await getAccountGateStatus('acct-1', {
      getAccountSummary: async () => ({ accountId: 'acct-1', role: 'user', identities: [{ type: 'crossmint', providerId: 'cm-1' }] }),
      getGateStatus: async () => gateStatus(0, 0) as any,
    });

    expect(result.gateWallet).toBe(null);
    expect(result.gateStatus).toBe(null);
    expect(result.gateStatusByWallet).toEqual({});
  });

  it('dedupes wallets and picks best by availableSlots then nftsHeld', async () => {
    const result = await getAccountGateStatus('acct-1', {
      getAccountSummary: async () => ({
        accountId: 'acct-1',
        role: 'user',
        identities: [
          { type: 'wallet', providerId: 'w1' },
          { type: 'wallet', providerId: 'w1' },
          { type: 'wallet', providerId: 'w2' },
          { type: 'wallet', providerId: 'w3' },
        ],
      }),
      getGateStatus: async (wallet: string) => {
        if (wallet === 'w1') return gateStatus(0, 10) as any;
        if (wallet === 'w2') return gateStatus(2, 0) as any;
        return gateStatus(2, 5) as any;
      },
    });

    // w3 and w2 tie on availableSlots=2; w3 wins on nftsHeld=5
    expect(result.gateWallet).toBe('w3');
    expect(result.gateStatus?.availableSlots).toBe(2);
    expect(Object.keys(result.gateStatusByWallet).sort()).toEqual(['w1', 'w2', 'w3']);
  });
});
