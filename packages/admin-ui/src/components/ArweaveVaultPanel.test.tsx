import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArweaveVaultPanel } from './ArweaveVaultPanel';

const mocks = vi.hoisted(() => {
  const vault = {
    schema: 'chat.rati.swarm.encrypted-vault',
    version: 1,
    createdAt: '2026-06-20T00:00:00.000Z',
    walletAddress: 'So11111111111111111111111111111111111111112',
    walletSource: 'phantom',
    key: {
      kind: 'solana-signature-hkdf-aes-gcm',
      message: 'sign me',
      salt: 'salt',
      iv: 'iv',
    },
    manifest: {
      app: 'Swarm',
      storageKeys: ['swarm:web-local:v1'],
      byteLength: 42,
    },
    ciphertext: 'ciphertext',
  };

  const wallet = {
    name: 'Phantom',
    source: 'phantom',
    provider: {
      isConnected: true,
      publicKey: { toString: () => vault.walletAddress },
      signMessage: vi.fn(),
    },
  };

  return {
    copyTextToClipboard: vi.fn(async () => undefined),
    decryptVault: vi.fn(),
    detectVaultWallets: vi.fn(() => [wallet]),
    downloadVault: vi.fn(),
    encryptLocalSnapshot: vi.fn(async () => vault),
    fetchVaultFromArweave: vi.fn(),
    parseVaultJson: vi.fn(),
    restoreLocalSnapshot: vi.fn(),
    vault,
    vaultToJson: vi.fn(() => '{"schema":"chat.rati.swarm.encrypted-vault"}'),
  };
});

vi.mock('../services/arweave-vault', () => ({
  decryptVault: mocks.decryptVault,
  detectVaultWallets: mocks.detectVaultWallets,
  downloadVault: mocks.downloadVault,
  encryptLocalSnapshot: mocks.encryptLocalSnapshot,
  fetchVaultFromArweave: mocks.fetchVaultFromArweave,
  parseVaultJson: mocks.parseVaultJson,
  restoreLocalSnapshot: mocks.restoreLocalSnapshot,
  vaultToJson: mocks.vaultToJson,
}));

vi.mock('../utils/clipboard', () => ({
  copyTextToClipboard: mocks.copyTextToClipboard,
}));

describe('ArweaveVaultPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.dataset.swarmWebLocal = 'true';
  });

  it('lets users copy the encrypted vault JSON after saving', async () => {
    render(<ArweaveVaultPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Save vault' }));

    await screen.findByText(/Last vault: 1 keys, 42 bytes, owner So11\.\.\.1112\./);
    expect(mocks.downloadVault).toHaveBeenCalledWith(mocks.vault);
    expect(screen.getByText(/Upload the downloaded or copied JSON/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy vault JSON' }));

    await waitFor(() => {
      expect(mocks.vaultToJson).toHaveBeenCalledWith(mocks.vault);
      expect(mocks.copyTextToClipboard).toHaveBeenCalledWith('{"schema":"chat.rati.swarm.encrypted-vault"}');
    });
    expect(await screen.findByText(/Encrypted vault JSON copied/)).toBeInTheDocument();
  });

  it('stays hidden outside web-local mode', () => {
    delete document.documentElement.dataset.swarmWebLocal;

    const { container } = render(<ArweaveVaultPanel />);

    expect(container).toBeEmptyDOMElement();
  });
});
