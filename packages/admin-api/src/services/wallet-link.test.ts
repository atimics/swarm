import { describe, it, expect, mock } from 'bun:test';
import { createLinkWalletChallenge, verifyLinkWallet, type WalletLinkDeps } from './wallet-link.js';

type DbItem = Record<string, unknown>;

function makeInMemoryDynamo() {
  const store = new Map<string, DbItem>();
  const keyOf = (pk: string, sk: string) => `${pk}|${sk}`;

  const send = async (cmd: unknown) => {
    const command = cmd as { input?: any; constructor?: { name?: string } };
    const input = command?.input ?? {};

    if (command?.constructor?.name === 'PutCommand' && input.Item) {
      const item = input.Item as DbItem;
      store.set(keyOf(item.pk, item.sk), item);
      return {};
    }

    if (command?.constructor?.name === 'GetCommand' && input.Key) {
      const { pk, sk } = input.Key;
      return { Item: store.get(keyOf(pk, sk)) };
    }

    if (command?.constructor?.name === 'DeleteCommand' && input.Key) {
      const { pk, sk } = input.Key;
      store.delete(keyOf(pk, sk));
      return {};
    }

    throw new Error(`Unexpected Dynamo command: ${command?.constructor?.name}`);
  };

  return { store, send };
}

function makeDeps(overrides?: Partial<WalletLinkDeps>): { deps: WalletLinkDeps; db: ReturnType<typeof makeInMemoryDynamo> } {
  const db = makeInMemoryDynamo();
  const deps: WalletLinkDeps = {
    dynamoClient: { send: db.send },
    tableName: 'test-admin-table',
    domain: 'admin.example.test',
    now: () => 1_700_000_000_000,
    generateNonce: () => 'nonce-1',
    verifySignature: () => true,
    getAccountIdForIdentity: async () => null,
    ensureIdentityLinkedToAccount: async () => ({ linked: true, conflict: false }),
    ...(overrides ?? {}),
  };
  return { deps, db };
}

describe('wallet-link service', () => {
  it('createLinkWalletChallenge errors when wallet is already linked to another account', async () => {
    const { deps } = makeDeps({
      getAccountIdForIdentity: async () => 'acct-other',
    });

    const result = await createLinkWalletChallenge({ accountId: 'acct-1', walletAddress: 'wallet-1' }, deps);

    expect('error' in result && result.error).toBe('Wallet is already linked to another account');
  });

  it('createLinkWalletChallenge stores a challenge record and returns message', async () => {
    const { deps, db } = makeDeps();

    const result = await createLinkWalletChallenge({ accountId: 'acct-1', walletAddress: 'wallet-1' }, deps);

    expect('nonce' in result).toBe(true);
    if ('nonce' in result) {
      expect(result.nonce).toBe('nonce-1');
      expect(result.message).toContain('Domain: admin.example.test');
      expect(result.message).toContain('Account: acct-1');
      expect(result.message).toContain('Wallet: wallet-1');
      expect(result.expiresAt).toBeGreaterThan(deps.now());
    }

    const stored = db.store.get('LINKCHALLENGE#nonce-1|DATA');
    expect(stored?.walletAddress).toBe('wallet-1');
    expect(stored?.accountId).toBe('acct-1');
  });

  it('verifyLinkWallet consumes challenge, validates signature, and links identity', async () => {
    const verifySignature = mock(() => true);
    const ensureIdentityLinkedToAccount = mock(async () => ({ linked: true, conflict: false }));
    const { deps, db } = makeDeps({ verifySignature, ensureIdentityLinkedToAccount });

    // Seed challenge record
    db.store.set('LINKCHALLENGE#nonce-1|DATA', {
      pk: 'LINKCHALLENGE#nonce-1',
      sk: 'DATA',
      nonce: 'nonce-1',
      accountId: 'acct-1',
      walletAddress: 'wallet-1',
      message: 'hello',
      createdAt: deps.now(),
      expiresAt: deps.now() + 1000,
      ttl: Math.floor((deps.now() + 1000) / 1000),
    });

    const result = await verifyLinkWallet(
      {
        accountId: 'acct-1',
        walletAddress: 'wallet-1',
        nonce: 'nonce-1',
        signatureBase58: 'sig',
      },
      deps
    );

    expect(result).toEqual({ success: true });
    expect(verifySignature).toHaveBeenCalledTimes(1);
    expect(ensureIdentityLinkedToAccount).toHaveBeenCalledTimes(1);

    // Challenge should be consumed (deleted)
    expect(db.store.has('LINKCHALLENGE#nonce-1|DATA')).toBe(false);
  });

  it('verifyLinkWallet does not loop on invalid signature (consumes the challenge once)', async () => {
    const verifySignature = mock(() => false);
    const { deps, db } = makeDeps({ verifySignature });

    db.store.set('LINKCHALLENGE#nonce-1|DATA', {
      pk: 'LINKCHALLENGE#nonce-1',
      sk: 'DATA',
      nonce: 'nonce-1',
      accountId: 'acct-1',
      walletAddress: 'wallet-1',
      message: 'hello',
      createdAt: deps.now(),
      expiresAt: deps.now() + 1000,
      ttl: Math.floor((deps.now() + 1000) / 1000),
    });

    const result = await verifyLinkWallet(
      {
        accountId: 'acct-1',
        walletAddress: 'wallet-1',
        nonce: 'nonce-1',
        signatureBase58: 'sig',
      },
      deps
    );

    expect(result).toEqual({ success: false, error: 'Invalid signature' });
    expect(verifySignature).toHaveBeenCalledTimes(1);
    expect(db.store.has('LINKCHALLENGE#nonce-1|DATA')).toBe(false);
  });
});
