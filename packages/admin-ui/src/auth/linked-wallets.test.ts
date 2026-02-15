import { describe, it, expect } from 'vitest';
import { getLinkedWalletDisplay, formatAddress } from './linked-wallets.js';

describe('linked wallets display', () => {
  it('formats addresses as prefix...suffix', () => {
    expect(formatAddress('ABCDEFGH12345678')).toBe('ABCD...5678');
  });

  it('shows up to two linked wallets and computes overflow', () => {
    const { labels, overflow } = getLinkedWalletDisplay({
      linkedWallets: ['w-primary-11111111', 'w-two-22222222', 'w-three-33333333', 'w-four-44444444'],
      primaryWallet: 'w-primary-11111111',
    });

    expect(labels.length).toBe(2);
    expect(overflow).toBe(1);
  });

  it('returns empty when there are no other wallets', () => {
    const { labels, overflow } = getLinkedWalletDisplay({
      linkedWallets: ['w-primary-11111111'],
      primaryWallet: 'w-primary-11111111',
    });

    expect(labels).toEqual([]);
    expect(overflow).toBe(0);
  });
});
