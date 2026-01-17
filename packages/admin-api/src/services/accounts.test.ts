import { describe, it, expect, beforeEach } from 'bun:test';
import {
  ensureIdentityLinkedToAccount,
  getAccountIdForIdentity,
  getAccountSummary,
  getOrCreateAccountForCrossmint,
  getOrCreateAccountForWallet,
  linkCrossmintIdentityToAccount,
  type AccountsServiceDeps,
} from './accounts.js';

type DbItem = Record<string, any>;

function makeInMemoryDynamo() {
  const store = new Map<string, DbItem>();

  const keyOf = (pk: string, sk: string) => `${pk}|${sk}`;
  const hasPk = (pk: string) => {
    for (const key of store.keys()) {
      if (key.startsWith(`${pk}|`)) return true;
    }
    return false;
  };

  const send = async (cmd: any) => {
    const input = cmd?.input ?? {};

    // Delete
    if (input.Key && cmd?.constructor?.name === 'DeleteCommand') {
      const { pk, sk } = input.Key;
      store.delete(keyOf(pk, sk));
      return {};
    }

    // Get
    if (input.Key) {
      const { pk, sk } = input.Key;
      return { Item: store.get(keyOf(pk, sk)) };
    }

    // Query
    if (input.KeyConditionExpression) {
      const pk = input.ExpressionAttributeValues[':pk'];
      const prefix = input.ExpressionAttributeValues[':prefix'];
      const items: DbItem[] = [];
      for (const [key, item] of store.entries()) {
        const [itemPk, itemSk] = key.split('|');
        if (itemPk === pk && typeof itemSk === 'string' && itemSk.startsWith(prefix)) {
          items.push(item);
        }
      }
      return { Items: items };
    }

    // Put
    if (input.Item) {
      const item = input.Item as DbItem;
      const pk = item.pk as string;
      const sk = item.sk as string;

      if (input.ConditionExpression === 'attribute_not_exists(pk)') {
        if (hasPk(pk)) {
          const err = new Error('ConditionalCheckFailedException');
          (err as any).name = 'ConditionalCheckFailedException';
          throw err;
        }
      }

      store.set(keyOf(pk, sk), item);
      return {};
    }

    throw new Error(`Unexpected Dynamo command shape: ${JSON.stringify(input)}`);
  };

  return { store, send };
}

describe('accounts service', () => {
  let db: ReturnType<typeof makeInMemoryDynamo>;
  let deps: AccountsServiceDeps;

  beforeEach(() => {
    db = makeInMemoryDynamo();
    deps = {
      dynamoClient: { send: db.send },
      tableName: 'test-admin-table',
      now: () => 1_700_000_000_000,
      uuid: () => 'acct-1',
    };
  });

  it('creates an account for a new wallet and links identity mapping + account identity', async () => {
    const accountId = await getOrCreateAccountForWallet('wallet-1', deps);
    expect(accountId).toBe('acct-1');

    const mapped = await getAccountIdForIdentity('wallet', 'wallet-1', deps);
    expect(mapped).toBe('acct-1');

    const summary = await getAccountSummary('acct-1', deps);
    expect(summary?.accountId).toBe('acct-1');
    expect(summary?.identities).toEqual([{ type: 'wallet', providerId: 'wallet-1' }]);
  });

  it('merges Crossmint identity into an existing wallet-owned account when walletAddress is provided', async () => {
    // Pre-seed identity mapping: wallet -> existing account
    await ensureIdentityLinkedToAccount({ accountId: 'acct-existing', type: 'wallet', providerId: 'wallet-1' }, deps);
    // Also create the profile record for acct-existing
    await (deps.dynamoClient.send as any)({
      input: {
        TableName: deps.tableName,
        Item: { pk: 'ACCOUNT#acct-existing', sk: 'PROFILE', accountId: 'acct-existing', role: 'user', createdAt: deps.now() },
      },
    });

    const accountId = await getOrCreateAccountForCrossmint(
      { crossmintUserId: 'cm-user-1', walletAddress: 'wallet-1' },
      deps
    );

    expect(accountId).toBe('acct-existing');

    const mapped = await getAccountIdForIdentity('crossmint', 'cm-user-1', deps);
    expect(mapped).toBe('acct-existing');
  });

  it('supports multiple linked wallets per account and lists them in account summary', async () => {
    const accountId = await getOrCreateAccountForWallet('wallet-1', deps);
    expect(accountId).toBe('acct-1');

    await ensureIdentityLinkedToAccount({ accountId, type: 'wallet', providerId: 'wallet-2' }, deps);

    const summary = await getAccountSummary(accountId, deps);
    const wallets = (summary?.identities ?? []).filter((i) => i.type === 'wallet').map((i) => i.providerId).sort();
    expect(wallets).toEqual(['wallet-1', 'wallet-2']);
  });

  it('links Crossmint identity to an existing account (success path)', async () => {
    // Create the account by wallet
    const accountId = await getOrCreateAccountForWallet('wallet-1', deps);

    const result = await linkCrossmintIdentityToAccount({ accountId, crossmintUserId: 'cm-user-1' }, deps);
    expect(result).toEqual({ success: true });

    const mapped = await getAccountIdForIdentity('crossmint', 'cm-user-1', deps);
    expect(mapped).toBe(accountId);
  });

  it('linkCrossmintIdentityToAccount returns conflict when Crossmint identity belongs to another account', async () => {
    // Seed profile records
    await (deps.dynamoClient.send as any)({
      input: {
        TableName: deps.tableName,
        Item: { pk: 'ACCOUNT#acct-1', sk: 'PROFILE', accountId: 'acct-1', role: 'user', createdAt: deps.now() },
      },
    });
    await (deps.dynamoClient.send as any)({
      input: {
        TableName: deps.tableName,
        Item: { pk: 'ACCOUNT#acct-other', sk: 'PROFILE', accountId: 'acct-other', role: 'user', createdAt: deps.now() },
      },
    });

    await ensureIdentityLinkedToAccount({ accountId: 'acct-other', type: 'crossmint', providerId: 'cm-user-1' }, deps);

    const result = await linkCrossmintIdentityToAccount({ accountId: 'acct-1', crossmintUserId: 'cm-user-1' }, deps);

    expect(result.success).toBe(false);
    if (result.success === false) {
      expect(result.conflict?.existingAccountId).toBe('acct-other');
    }
  });
});
