import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const ADMIN_TABLE = process.env.ADMIN_TABLE!;

export type IdentityType = 'wallet' | 'crossmint';

export interface AccountRecord {
  pk: string; // ACCOUNT#<accountId>
  sk: 'PROFILE';
  accountId: string;
  role: 'user' | 'admin';
  createdAt: number;
}

export interface IdentityMappingRecord {
  pk: string; // IDENTITY#<type>#<providerId>
  sk: 'ACCOUNT';
  identityType: IdentityType;
  providerId: string;
  accountId: string;
  createdAt: number;
}

export interface AccountIdentityRecord {
  pk: string; // ACCOUNT#<accountId>
  sk: string; // IDENTITY#<type>#<providerId>
  identityType: IdentityType;
  providerId: string;
  createdAt: number;
}

export interface AccountSummary {
  accountId: string;
  role: 'user' | 'admin';
  identities: Array<{ type: IdentityType; providerId: string }>;
}

export type LinkIdentityResult =
  | { success: true }
  | { success: false; error: string; conflict?: { type: IdentityType; providerId: string; existingAccountId: string } };

function identityPk(type: IdentityType, providerId: string): string {
  return `IDENTITY#${type}#${providerId}`;
}

function accountPk(accountId: string): string {
  return `ACCOUNT#${accountId}`;
}

function accountIdentitySk(type: IdentityType, providerId: string): string {
  return `IDENTITY#${type}#${providerId}`;
}

export async function getAccountIdForIdentity(
  type: IdentityType,
  providerId: string
): Promise<string | null> {
  const result = await dynamoClient.send(
    new GetCommand({
      TableName: ADMIN_TABLE,
      Key: { pk: identityPk(type, providerId), sk: 'ACCOUNT' },
    })
  );

  const mapping = result.Item as IdentityMappingRecord | undefined;
  return mapping?.accountId ?? null;
}

async function createAccount(): Promise<AccountRecord> {
  const now = Date.now();
  const accountId = randomUUID();
  const record: AccountRecord = {
    pk: accountPk(accountId),
    sk: 'PROFILE',
    accountId,
    role: 'user',
    createdAt: now,
  };

  await dynamoClient.send(
    new PutCommand({
      TableName: ADMIN_TABLE,
      Item: record,
      ConditionExpression: 'attribute_not_exists(pk)',
    })
  );

  return record;
}

export async function ensureIdentityLinkedToAccount(params: {
  accountId: string;
  type: IdentityType;
  providerId: string;
}): Promise<{ linked: boolean; conflict: boolean; existingAccountId?: string }> {
  const { accountId, type, providerId } = params;

  const existingAccountId = await getAccountIdForIdentity(type, providerId);
  if (existingAccountId && existingAccountId !== accountId) {
    return { linked: false, conflict: true, existingAccountId };
  }

  const now = Date.now();

  if (!existingAccountId) {
    try {
      await dynamoClient.send(
        new PutCommand({
          TableName: ADMIN_TABLE,
          Item: {
            pk: identityPk(type, providerId),
            sk: 'ACCOUNT',
            identityType: type,
            providerId,
            accountId,
            createdAt: now,
          } satisfies IdentityMappingRecord,
          ConditionExpression: 'attribute_not_exists(pk)',
        })
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
        const winner = await getAccountIdForIdentity(type, providerId);
        if (winner && winner !== accountId) {
          return { linked: false, conflict: true, existingAccountId: winner };
        }
        // If winner is us (or became us), proceed idempotently.
      } else {
        throw err;
      }
    }
  }

  // Idempotently attach identity under the account partition for listing.
  await dynamoClient.send(
    new PutCommand({
      TableName: ADMIN_TABLE,
      Item: {
        pk: accountPk(accountId),
        sk: accountIdentitySk(type, providerId),
        identityType: type,
        providerId,
        createdAt: now,
      } satisfies AccountIdentityRecord,
    })
  );

  return { linked: true, conflict: false };
}

export async function getOrCreateAccountForWallet(walletAddress: string): Promise<string> {
  const existing = await getAccountIdForIdentity('wallet', walletAddress);
  if (existing) return existing;

  const account = await createAccount();

  const linkResult = await ensureIdentityLinkedToAccount({
    accountId: account.accountId,
    type: 'wallet',
    providerId: walletAddress,
  });

  if (linkResult.conflict && linkResult.existingAccountId) {
    return linkResult.existingAccountId;
  }

  return account.accountId;
}

export async function getOrCreateAccountForCrossmint(params: {
  crossmintUserId: string;
  walletAddress?: string;
}): Promise<string> {
  const { crossmintUserId, walletAddress } = params;

  // Prefer existing wallet identity if present: this auto-merges Crossmint identity into the wallet-owned account.
  if (walletAddress) {
    const accountForWallet = await getAccountIdForIdentity('wallet', walletAddress);
    if (accountForWallet) {
      await ensureIdentityLinkedToAccount({
        accountId: accountForWallet,
        type: 'crossmint',
        providerId: crossmintUserId,
      });
      return accountForWallet;
    }
  }

  const accountForCrossmint = await getAccountIdForIdentity('crossmint', crossmintUserId);
  if (accountForCrossmint) {
    if (walletAddress) {
      await ensureIdentityLinkedToAccount({
        accountId: accountForCrossmint,
        type: 'wallet',
        providerId: walletAddress,
      });
    }
    return accountForCrossmint;
  }

  const account = await createAccount();

  await ensureIdentityLinkedToAccount({
    accountId: account.accountId,
    type: 'crossmint',
    providerId: crossmintUserId,
  });

  if (walletAddress) {
    await ensureIdentityLinkedToAccount({
      accountId: account.accountId,
      type: 'wallet',
      providerId: walletAddress,
    });
  }

  return account.accountId;
}

/**
 * Link a Crossmint identity to an existing account (without creating a new session).
 *
 * This is used when a user is signed in via wallet and wants to add email/social (Crossmint)
 * as an additional login method for the same account.
 */
export async function linkCrossmintIdentityToAccount(params: {
  accountId: string;
  crossmintUserId: string;
  walletAddress?: string;
}): Promise<LinkIdentityResult> {
  const { accountId, crossmintUserId, walletAddress } = params;

  const crossmintLink = await ensureIdentityLinkedToAccount({
    accountId,
    type: 'crossmint',
    providerId: crossmintUserId,
  });

  if (crossmintLink.conflict && crossmintLink.existingAccountId) {
    return {
      success: false,
      error: 'Crossmint identity is already linked to another account',
      conflict: {
        type: 'crossmint',
        providerId: crossmintUserId,
        existingAccountId: crossmintLink.existingAccountId,
      },
    };
  }

  if (walletAddress) {
    const walletLink = await ensureIdentityLinkedToAccount({
      accountId,
      type: 'wallet',
      providerId: walletAddress,
    });

    if (walletLink.conflict && walletLink.existingAccountId) {
      return {
        success: false,
        error: 'Wallet is already linked to another account',
        conflict: {
          type: 'wallet',
          providerId: walletAddress,
          existingAccountId: walletLink.existingAccountId,
        },
      };
    }
  }

  return { success: true };
}

export async function getAccountSummary(accountId: string): Promise<AccountSummary | null> {
  const accountResult = await dynamoClient.send(
    new GetCommand({
      TableName: ADMIN_TABLE,
      Key: { pk: accountPk(accountId), sk: 'PROFILE' },
    })
  );

  const account = accountResult.Item as AccountRecord | undefined;
  if (!account) return null;

  const identitiesResult = await dynamoClient.send(
    new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': accountPk(accountId),
        ':prefix': 'IDENTITY#',
      },
    })
  );

  const identities = (identitiesResult.Items as AccountIdentityRecord[] | undefined) ?? [];

  return {
    accountId: account.accountId,
    role: account.role,
    identities: identities.map(i => ({ type: i.identityType, providerId: i.providerId })),
  };
}
