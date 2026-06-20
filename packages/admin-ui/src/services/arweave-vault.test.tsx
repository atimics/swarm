import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLocalSnapshot,
  decryptVault,
  encryptLocalSnapshot,
  fetchVaultFromArweave,
  normalizeArweaveId,
  parseVaultJson,
  restoreLocalSnapshot,
  vaultToJson,
  type DetectedVaultWallet,
  type SolanaVaultProvider,
} from './arweave-vault';

function makeWallet(address = 'So11111111111111111111111111111111111111112'): DetectedVaultWallet {
  const provider: SolanaVaultProvider = {
    isConnected: true,
    publicKey: { toString: () => address },
    signMessage: vi.fn(async () => ({
      signature: new Uint8Array(Array.from({ length: 64 }, (_, index) => index + 1)),
    })),
  };
  return { name: 'Test Wallet', source: 'phantom', provider };
}

describe('arweave vault', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('snapshots only Swarm local state keys', () => {
    localStorage.setItem('swarm:web-local:v1', '{"avatars":[]}');
    localStorage.setItem('swarm-auth', '{"authenticated":true}');
    localStorage.setItem('third-party', 'do-not-export');

    const snapshot = createLocalSnapshot();

    expect(snapshot.schema).toBe('chat.rati.swarm.local-snapshot');
    expect(snapshot.storage).toEqual({
      'swarm:web-local:v1': '{"avatars":[]}',
      'swarm-auth': '{"authenticated":true}',
    });
  });

  it('encrypts and decrypts a portable local snapshot with a wallet signature', async () => {
    localStorage.setItem('swarm:web-local:v1', '{"avatars":[{"name":"Avatar 1"}]}');
    localStorage.setItem('swarm-theme', 'dark');
    const wallet = makeWallet();

    const vault = await encryptLocalSnapshot(wallet);
    const decrypted = await decryptVault(vault, wallet);

    expect(vault.schema).toBe('chat.rati.swarm.encrypted-vault');
    expect(vault.walletAddress).toBe('So11111111111111111111111111111111111111112');
    expect(vault.manifest.storageKeys).toEqual(['swarm-theme', 'swarm:web-local:v1']);
    expect(decrypted.storage['swarm:web-local:v1']).toContain('Avatar 1');
    expect(decrypted.storage['swarm-theme']).toBe('dark');
  });

  it('rejects decrypting a vault with a different wallet address', async () => {
    localStorage.setItem('swarm:web-local:v1', '{"avatars":[]}');
    const vault = await encryptLocalSnapshot(makeWallet());

    await expect(decryptVault(vault, makeWallet('DifferentWallet1111111111111111111111111111')))
      .rejects
      .toThrow(/Connect So11\.\.\.1112/);
  });

  it('restores snapshot state and removes stale Swarm keys', () => {
    localStorage.setItem('swarm:web-local:v1', 'old');
    localStorage.setItem('swarm-theme', 'stale');
    localStorage.setItem('third-party', 'keep');

    restoreLocalSnapshot({
      schema: 'chat.rati.swarm.local-snapshot',
      version: 1,
      createdAt: new Date().toISOString(),
      origin: 'https://swarm.rati.chat',
      storage: { 'swarm:web-local:v1': 'new' },
    });

    expect(localStorage.getItem('swarm:web-local:v1')).toBe('new');
    expect(localStorage.getItem('swarm-theme')).toBeNull();
    expect(localStorage.getItem('third-party')).toBe('keep');
  });

  it('loads a vault from an Arweave transaction id or gateway URL', async () => {
    localStorage.setItem('swarm:web-local:v1', '{"avatars":[]}');
    const vault = await encryptLocalSnapshot(makeWallet());
    const fetchMock = vi.fn(async () => new Response(vaultToJson(vault), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchVaultFromArweave('https://arweave.net/abc123')).resolves.toMatchObject({
      schema: 'chat.rati.swarm.encrypted-vault',
      walletAddress: vault.walletAddress,
    });

    expect(normalizeArweaveId('https://arweave.net/abc123')).toBe('abc123');
    expect(fetchMock).toHaveBeenCalledWith('https://arweave.net/abc123');
    expect(parseVaultJson(vaultToJson(vault))).toEqual(vault);
  });
});
