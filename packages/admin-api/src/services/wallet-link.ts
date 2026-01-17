import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomBytes } from 'crypto';
import { verifySignature } from './wallet-auth.js';
import {
  ensureIdentityLinkedToAccount,
  getAccountIdForIdentity,
  type IdentityType,
} from './accounts.js';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const ADMIN_TABLE = process.env.ADMIN_TABLE!;
const LINK_CHALLENGE_TTL_MINUTES = 5;
const DOMAIN = process.env.AUTH_DOMAIN || 'admin.rati.chat';

export interface WalletLinkDeps {
  dynamoClient: Pick<DynamoDBDocumentClient, 'send'>;
  tableName: string;
  domain: string;
  now: () => number;
  generateNonce: () => string;
  verifySignature: (message: string, signatureBase58: string, walletAddress: string) => boolean;
  getAccountIdForIdentity: (type: IdentityType, providerId: string) => Promise<string | null>;
  ensureIdentityLinkedToAccount: (params: {
    accountId: string;
    type: IdentityType;
    providerId: string;
  }) => Promise<{ linked: boolean; conflict: boolean; existingAccountId?: string }>;
}

function getDefaultDeps(): WalletLinkDeps {
  return {
    dynamoClient,
    tableName: ADMIN_TABLE,
    domain: DOMAIN,
    now: () => Date.now(),
    generateNonce: () => generateNonce(),
    verifySignature,
    getAccountIdForIdentity,
    ensureIdentityLinkedToAccount,
  };
}

interface LinkChallengeRecord {
  pk: string; // LINKCHALLENGE#<nonce>
  sk: 'DATA';
  nonce: string;
  accountId: string;
  walletAddress: string;
  message: string;
  createdAt: number;
  expiresAt: number;
  ttl: number;
}

function generateNonce(): string {
  return randomBytes(32).toString('hex');
}

function createLinkChallengeMessage(params: {
  accountId: string;
  walletAddress: string;
  nonce: string;
  domain: string;
  nowMs: number;
}): {
  message: string;
  expiresAt: number;
} {
  const now = new Date(params.nowMs);
  const expiration = new Date(now.getTime() + LINK_CHALLENGE_TTL_MINUTES * 60 * 1000);

  const message = `Sign this message to link a Solana wallet to your Swarm account.

Domain: ${params.domain}
Account: ${params.accountId}
Wallet: ${params.walletAddress}
Nonce: ${params.nonce}
Issued At: ${now.toISOString()}
Expiration: ${expiration.toISOString()}

This signature will not trigger any blockchain transaction or cost any fees.`;

  return { message, expiresAt: expiration.getTime() };
}

export async function createLinkWalletChallenge(params: {
  accountId: string;
  walletAddress: string;
}, deps: WalletLinkDeps = getDefaultDeps()): Promise<{ nonce: string; message: string; expiresAt: number } | { error: string }> {
  const existingAccountId = await deps.getAccountIdForIdentity('wallet' satisfies IdentityType, params.walletAddress);
  if (existingAccountId && existingAccountId !== params.accountId) {
    return { error: 'Wallet is already linked to another account' };
  }

  const nonce = deps.generateNonce();
  const nowMs = deps.now();
  const { message, expiresAt } = createLinkChallengeMessage({
    accountId: params.accountId,
    walletAddress: params.walletAddress,
    nonce,
    domain: deps.domain,
    nowMs,
  });

  const now = nowMs;

  const record: LinkChallengeRecord = {
    pk: `LINKCHALLENGE#${nonce}`,
    sk: 'DATA',
    nonce,
    accountId: params.accountId,
    walletAddress: params.walletAddress,
    message,
    createdAt: now,
    expiresAt,
    ttl: Math.floor(expiresAt / 1000),
  };

  await deps.dynamoClient.send(
    new PutCommand({
      TableName: deps.tableName,
      Item: record,
    })
  );

  return { nonce, message, expiresAt };
}

async function consumeLinkChallenge(nonce: string, deps: WalletLinkDeps): Promise<LinkChallengeRecord | null> {
  const result = await deps.dynamoClient.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: { pk: `LINKCHALLENGE#${nonce}`, sk: 'DATA' },
    })
  );

  if (!result.Item) return null;

  const challenge = result.Item as LinkChallengeRecord;
  if (deps.now() > challenge.expiresAt) {
    return null;
  }

  await deps.dynamoClient.send(
    new DeleteCommand({
      TableName: deps.tableName,
      Key: { pk: `LINKCHALLENGE#${nonce}`, sk: 'DATA' },
    })
  );

  return challenge;
}

export async function verifyLinkWallet(params: {
  accountId: string;
  walletAddress: string;
  nonce: string;
  signatureBase58: string;
}, deps: WalletLinkDeps = getDefaultDeps()): Promise<{ success: true } | { success: false; error: string }> {
  const challenge = await consumeLinkChallenge(params.nonce, deps);
  if (!challenge) {
    return { success: false, error: 'Invalid or expired challenge' };
  }

  if (challenge.accountId !== params.accountId || challenge.walletAddress !== params.walletAddress) {
    return { success: false, error: 'Challenge does not match request' };
  }

  const valid = deps.verifySignature(challenge.message, params.signatureBase58, params.walletAddress);
  if (!valid) {
    return { success: false, error: 'Invalid signature' };
  }

  const linkResult = await deps.ensureIdentityLinkedToAccount({
    accountId: params.accountId,
    type: 'wallet',
    providerId: params.walletAddress,
  });

  if (linkResult.conflict) {
    return { success: false, error: 'Wallet is already linked to another account' };
  }

  return { success: true };
}
