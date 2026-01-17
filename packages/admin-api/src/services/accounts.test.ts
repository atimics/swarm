import { describe, it, expect, beforeEach } from 'bun:test';
import {
  ensureIdentityLinkedToAccount,
  getAccountIdForIdentity,
  getAccountSummary,
  getOrCreateAccountForCrossmint,
  getOrCreateAccountForPrivy,
  getOrCreateAccountForWallet,
  linkCrossmintIdentityToAccount,
  linkPrivyIdentityToAccount,
  type AccountsServiceDeps,
} from './accounts.js';

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

type DbItem = Record<string, unknown>;

function makeInMemoryDynamo() {
  const store = new Map<string, DbItem>();

  const keyOf = (pk: string, sk: string) => `${pk}|${sk}`;
  const hasPk = (pk: string) => {
    for (const key of store.keys()) {
      if (key.startsWith(`${pk}|`)) return true;
    }
    return false;
  };

  const send: DynamoDBDocumentClient['send'] = async (cmd: unknown) => {
    const command = cmd as { input?: Record<string, unknown>; constructor?: { name?: string } };
    const input = command?.input ?? {};

    // Delete
    if ((input as { Key?: { pk: string; sk: string } }).Key && command?.constructor?.name === 'DeleteCommand') {
      const { pk, sk } = (input as { Key: { pk: string; sk: string } }).Key;
      store.delete(keyOf(pk, sk));
      return {};
    }

    // Get
    if ((input as { Key?: { pk: string; sk: string } }).Key) {
      const { pk, sk } = (input as { Key: { pk: string; sk: string } }).Key;
      return { Item: store.get(keyOf(pk, sk)) };
    }

    // Query
    if ((input as { KeyConditionExpression?: unknown; ExpressionAttributeValues?: Record<string, unknown> }).KeyConditionExpression) {
      const eavs = (input as { ExpressionAttributeValues: Record<string, unknown> }).ExpressionAttributeValues;
      const pk = eavs[':pk'] as string;
      const prefix = eavs[':prefix'] as string;
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
    if ((input as { Item?: DbItem }).Item) {
      const item = (input as { Item: DbItem }).Item;
      const pk = item.pk as string;
      const sk = item.sk as string;

      if ((input as { ConditionExpression?: string }).ConditionExpression === 'attribute_not_exists(pk)') {
        if (hasPk(pk)) {
          const err = new Error('ConditionalCheckFailedException');
          (err as { name?: string }).name = 'ConditionalCheckFailedException';
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

  it('merges Privy identity into an existing wallet-owned account when walletAddress is provided', async () => {
    await ensureIdentityLinkedToAccount({ accountId: 'acct-existing', type: 'wallet', providerId: 'wallet-1' }, deps);
    await (deps.dynamoClient.send as any)({
      input: {
        TableName: deps.tableName,
        Item: { pk: 'ACCOUNT#acct-existing', sk: 'PROFILE', accountId: 'acct-existing', role: 'user', createdAt: deps.now() },
      },
    });

    const accountResult = await getOrCreateAccountForPrivy({ privyUserId: 'privy-user-1', walletAddress: 'wallet-1' }, deps);
    expect(accountResult.success).toBe(true);
    if (accountResult.success) {
      expect(accountResult.accountId).toBe('acct-existing');
    }

    const mapped = await getAccountIdForIdentity('privy', 'privy-user-1', deps);
    expect(mapped).toBe('acct-existing');
  });

  it('getOrCreateAccountForPrivy returns conflict if privy and wallet identities point to different accounts', async () => {
    // Seed profiles
    await (deps.dynamoClient.send as any)({
      input: {
        TableName: deps.tableName,
        Item: { pk: 'ACCOUNT#acct-wallet', sk: 'PROFILE', accountId: 'acct-wallet', role: 'user', createdAt: deps.now() },
      },
    });
    await (deps.dynamoClient.send as any)({
      input: {
        TableName: deps.tableName,
        Item: { pk: 'ACCOUNT#acct-privy', sk: 'PROFILE', accountId: 'acct-privy', role: 'user', createdAt: deps.now() },
      },
    });

    await ensureIdentityLinkedToAccount({ accountId: 'acct-wallet', type: 'wallet', providerId: 'wallet-1' }, deps);
    await ensureIdentityLinkedToAccount({ accountId: 'acct-privy', type: 'privy', providerId: 'privy-user-1' }, deps);

    const accountResult = await getOrCreateAccountForPrivy({ privyUserId: 'privy-user-1', walletAddress: 'wallet-1' }, deps);
    expect(accountResult.success).toBe(false);
    if (!accountResult.success) {
      expect(accountResult.conflict.existingAccountId).toBe('acct-privy');
    }
  });

  it('links Privy identity to an existing account (success path)', async () => {
    const accountId = await getOrCreateAccountForWallet('wallet-1', deps);

    const result = await linkPrivyIdentityToAccount({ accountId, privyUserId: 'privy-user-1' }, deps);
    expect(result).toEqual({ success: true });

    const mapped = await getAccountIdForIdentity('privy', 'privy-user-1', deps);
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
