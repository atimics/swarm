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

function createLinkChallengeMessage(params: { accountId: string; walletAddress: string; nonce: string }): {
  message: string;
  expiresAt: number;
} {
  const now = new Date();
  const expiration = new Date(now.getTime() + LINK_CHALLENGE_TTL_MINUTES * 60 * 1000);

  const message = `Sign this message to link a Solana wallet to your Swarm account.

Domain: ${DOMAIN}
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
}): Promise<{ nonce: string; message: string; expiresAt: number } | { error: string }> {
  const existingAccountId = await getAccountIdForIdentity('wallet' satisfies IdentityType, params.walletAddress);
  if (existingAccountId && existingAccountId !== params.accountId) {
    return { error: 'Wallet is already linked to another account' };
  }

  const nonce = generateNonce();
  const { message, expiresAt } = createLinkChallengeMessage({
    accountId: params.accountId,
    walletAddress: params.walletAddress,
    nonce,
  });

  const now = Date.now();

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

  await dynamoClient.send(
    new PutCommand({
      TableName: ADMIN_TABLE,
      Item: record,
    })
  );

  return { nonce, message, expiresAt };
}

async function consumeLinkChallenge(nonce: string): Promise<LinkChallengeRecord | null> {
  const result = await dynamoClient.send(
    new GetCommand({
      TableName: ADMIN_TABLE,
      Key: { pk: `LINKCHALLENGE#${nonce}`, sk: 'DATA' },
    })
  );

  if (!result.Item) return null;

  const challenge = result.Item as LinkChallengeRecord;
  if (Date.now() > challenge.expiresAt) {
    return null;
  }

  await dynamoClient.send(
    new DeleteCommand({
      TableName: ADMIN_TABLE,
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
}): Promise<{ success: true } | { success: false; error: string }> {
  const challenge = await consumeLinkChallenge(params.nonce);
  if (!challenge) {
    return { success: false, error: 'Invalid or expired challenge' };
  }

  if (challenge.accountId !== params.accountId || challenge.walletAddress !== params.walletAddress) {
    return { success: false, error: 'Challenge does not match request' };
  }

  const valid = verifySignature(challenge.message, params.signatureBase58, params.walletAddress);
  if (!valid) {
    return { success: false, error: 'Invalid signature' };
  }

  const linkResult = await ensureIdentityLinkedToAccount({
    accountId: params.accountId,
    type: 'wallet',
    providerId: params.walletAddress,
  });

  if (linkResult.conflict) {
    return { success: false, error: 'Wallet is already linked to another account' };
  }

  return { success: true };
}
