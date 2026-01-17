/**
 * NFT Gating Service
 * Verifies wallet holds required NFTs for access and creation gating
 *
 * Gate NFT serves two purposes:
 * 1. HOLDING = Permission to create avatars (1 NFT held = 1 creation slot)
 * 2. BURNING = Permission to abandon an inhabited avatar
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

// Required collection for access (Orb/Gate NFTs)
const GATE_COLLECTION = '8GCAyy5L2o2ZPdQKo3EtYAYNKYT8Y6sqGHweintLTSJ';

// Helius API key - can come from env var or Secrets Manager
const HELIUS_API_KEY_ARN = process.env.HELIUS_API_KEY_ARN;
let heliusApiKey: string | null = process.env.HELIUS_API_KEY || null;
let heliusApiKeyFetched = false;

const secretsClient = new SecretsManagerClient({});

async function getHeliusApiKey(): Promise<string | null> {
  // If we already have it from env, use it
  if (heliusApiKey) return heliusApiKey;
  
  // If we've already tried fetching, don't retry
  if (heliusApiKeyFetched) return null;
  heliusApiKeyFetched = true;
  
  // Try to fetch from Secrets Manager
  if (HELIUS_API_KEY_ARN) {
    try {
      const response = await secretsClient.send(new GetSecretValueCommand({
        SecretId: HELIUS_API_KEY_ARN,
      }));
      heliusApiKey = response.SecretString || null;
      return heliusApiKey;
    } catch (error) {
      console.error('[NFTGate] Failed to fetch Helius API key from Secrets Manager:', error);
    }
  }
  
  return null;
}

async function getHeliusRpcUrl(): Promise<string | null> {
  const apiKey = await getHeliusApiKey();
  // DAS API methods like getAssetsByOwner only work with Helius, not public RPC
  return apiKey
    ? `https://mainnet.helius-rpc.com/?api-key=${apiKey}`
    : null;
}

const ADMIN_TABLE = process.env.ADMIN_TABLE!;
const CREATOR_STATS_SK = 'STATS';
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

function creatorStatsKey(walletAddress: string): { pk: string; sk: string } {
  return {
    pk: `CREATOR#${walletAddress}`,
    sk: CREATOR_STATS_SK,
  };
}

async function recalculateCreatorCount(walletAddress: string): Promise<number> {
  const result = await dynamoClient.send(new ScanCommand({
    TableName: ADMIN_TABLE,
    FilterExpression: 'sk = :sk AND creatorWallet = :wallet AND #status <> :deleted',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':sk': 'CONFIG',
      ':wallet': walletAddress,
      ':deleted': 'deleted',
    },
    Select: 'COUNT',
  }));

  const count = result.Count || 0;

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: {
      ...creatorStatsKey(walletAddress),
      avatarsCreated: count,
      updatedAt: Date.now(),
    },
  }));

  return count;
}

export async function incrementCreatorCount(walletAddress: string): Promise<void> {
  try {
    await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: creatorStatsKey(walletAddress),
      UpdateExpression: 'SET avatarsCreated = if_not_exists(avatarsCreated, :zero) + :one, updatedAt = :now',
      ExpressionAttributeValues: {
        ':zero': 0,
        ':one': 1,
        ':now': Date.now(),
      },
    }));
  } catch (error) {
    console.warn('[NFTGate] Failed to increment creator count, recalculating', error);
    await recalculateCreatorCount(walletAddress).catch((recalcError) => {
      console.error('[NFTGate] Failed to recalculate creator count', recalcError);
    });
  }
}

export async function decrementCreatorCount(walletAddress: string): Promise<void> {
  try {
    const stats = await dynamoClient.send(new GetCommand({
      TableName: ADMIN_TABLE,
      Key: creatorStatsKey(walletAddress),
    }));

    const current = typeof stats.Item?.avatarsCreated === 'number'
      ? stats.Item.avatarsCreated as number
      : null;

    if (current === null) {
      await recalculateCreatorCount(walletAddress);
      return;
    }

    const nextCount = Math.max(0, current - 1);
    await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: creatorStatsKey(walletAddress),
      UpdateExpression: 'SET avatarsCreated = :next, updatedAt = :now',
      ExpressionAttributeValues: {
        ':next': nextCount,
        ':now': Date.now(),
      },
    }));
  } catch (error) {
    console.warn('[NFTGate] Failed to decrement creator count, recalculating', error);
    await recalculateCreatorCount(walletAddress).catch((recalcError) => {
      console.error('[NFTGate] Failed to recalculate creator count', recalcError);
    });
  }
}

export interface NFTAsset {
  id: string;
  content: {
    metadata: {
      name: string;
      symbol?: string;
    };
    files?: Array<{ uri: string; cdn_uri?: string }>;
    links?: { image?: string };
  };
  grouping: Array<{
    group_key: string;
    group_value: string;
  }>;
  ownership: {
    owner: string;
  };
}

export interface NFTGateResult {
  allowed: boolean;
  ownedCount: number;
  requiredCollection: string;
  ownedNFTs: Array<{
    id: string;
    name: string;
    image?: string;
  }>;
  error?: string;
}

/**
 * Full gate status for creation/abandonment gating
 */
export interface GateStatus {
  nftsHeld: number;
  avatarsCreated: number;
  availableSlots: number;
  canCreate: boolean;
  canAbandon: boolean;
  ownedNFTs: Array<{
    id: string;
    name: string;
    image?: string;
  }>;
}

/**
 * Check if a wallet owns any NFTs from the Gate collection
 */
export async function checkNFTGate(walletAddress: string): Promise<NFTGateResult> {
  const result: NFTGateResult = {
    allowed: false,
    ownedCount: 0,
    requiredCollection: GATE_COLLECTION,
    ownedNFTs: [],
  };

  try {
    // Use Helius DAS API to get NFTs by owner filtered by collection
    const heliusRpcUrl = await getHeliusRpcUrl();
    
    // If no Helius API key, NFT gating is disabled - allow all users
    if (!heliusRpcUrl) {
      console.log('[NFTGate] No Helius API key configured, NFT gating disabled - allowing access');
      result.allowed = true;
      result.ownedCount = 999; // Grant unlimited slots when gating is disabled
      return result;
    }
    
    const response = await fetch(heliusRpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'nft-gate-check',
        method: 'getAssetsByOwner',
        params: {
          ownerAddress: walletAddress,
          page: 1,
          limit: 100,
          displayOptions: {
            showCollectionMetadata: true,
          },
        },
      }),
    });

    if (!response.ok) {
      console.error('[NFTGate] Helius API error:', response.status);
      result.error = 'Failed to verify NFT ownership';
      return result;
    }

    const data = await response.json() as {
      error?: { message?: string };
      result?: { items?: NFTAsset[] };
    };

    if (data.error) {
      console.error('[NFTGate] RPC error:', data.error);
      result.error = data.error.message || 'RPC error';
      return result;
    }

    const assets = data.result?.items || [];

    // Filter for NFTs in the Gate collection
    const matchingNFTs = assets.filter((asset) => {
      const collection = asset.grouping?.find(
        (g) => g.group_key === 'collection'
      );
      return collection?.group_value === GATE_COLLECTION;
    });

    result.ownedCount = matchingNFTs.length;
    result.allowed = matchingNFTs.length > 0;
    result.ownedNFTs = matchingNFTs.map((nft) => ({
      id: nft.id,
      name: nft.content?.metadata?.name || 'Unknown',
      image: nft.content?.links?.image || nft.content?.files?.[0]?.cdn_uri,
    }));

    console.log(
      `[NFTGate] Wallet ${walletAddress.slice(0, 8)}... owns ${matchingNFTs.length} Gate NFTs`
    );

    return result;
  } catch (error) {
    console.error('[NFTGate] Error checking NFT ownership:', error);
    result.error = 'Failed to verify NFT ownership';
    return result;
  }
}

/**
 * Count avatars created by a wallet
 */
export async function countAvatarsCreatedBy(walletAddress: string): Promise<number> {
  try {
    const stats = await dynamoClient.send(new GetCommand({
      TableName: ADMIN_TABLE,
      Key: creatorStatsKey(walletAddress),
    }));

    if (typeof stats.Item?.avatarsCreated === 'number') {
      return stats.Item.avatarsCreated as number;
    }
  } catch (error) {
    console.warn('[NFTGate] Failed to read creator stats, recalculating', error);
  }

  try {
    return await recalculateCreatorCount(walletAddress);
  } catch (scanError) {
    console.error('[NFTGate] Error counting avatars:', scanError);
    return 0;
  }
}

/**
 * Get full gate status for a wallet
 * Used for creation gating and abandonment checks
 * 
 * Every wallet gets 1 free avatar slot. Additional slots require holding Orb NFTs.
 * Formula: availableSlots = (1 + nftsHeld) - avatarsCreated
 */
export async function getGateStatus(walletAddress: string): Promise<GateStatus> {
  // Get NFT count from on-chain
  const nftResult = await checkNFTGate(walletAddress);
  const nftsHeld = nftResult.ownedCount;

  // Get avatars created by this wallet from DynamoDB
  const avatarsCreated = await countAgentsCreatedBy(walletAddress);

  // Every wallet gets 1 free slot + 1 slot per NFT held
  const FREE_SLOTS = 1;
  const totalSlots = FREE_SLOTS + nftsHeld;
  const availableSlots = Math.max(0, totalSlots - avatarsCreated);

  return {
    nftsHeld,
    avatarsCreated,
    availableSlots,
    canCreate: availableSlots > 0,
    // Can abandon if holding at least 1 NFT (to receive lineage NFT)
    canAbandon: nftsHeld >= 1,
    ownedNFTs: nftResult.ownedNFTs,
  };
}

/**
 * Get the Gate collection address
 */
export function getGateCollection(): string {
  return GATE_COLLECTION;
}

/**
 * @deprecated Use getGateCollection instead
 */
export function getRequiredCollection(): string {
  return GATE_COLLECTION;
}

/** @deprecated Use countAvatarsCreatedBy instead */
export const countAgentsCreatedBy = countAvatarsCreatedBy;
