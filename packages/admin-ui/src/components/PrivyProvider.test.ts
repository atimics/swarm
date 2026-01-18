import { describe, it, expect } from 'bun:test';
import { buildPrivyConfig } from './PrivyProvider.js';

describe('PrivyProvider config', () => {
  it('sets Solana defaults for wallets', () => {
    const config = buildPrivyConfig();

    expect(config.loginMethods).toEqual(['email', 'google', 'twitter']);
    expect(config.embeddedWallets?.solana?.createOnLogin).toBe('users-without-wallets');
    expect(config.defaultChain).toBeUndefined();
    expect(config.supportedChains).toBeUndefined();
  });
});
