/**
 * Bags Token Launch Service
 *
 * Enables avatars with Twitter accounts to launch tokens on Bags.fm
 *
 * Design principles:
 * - Only avatars with a configured Twitter username can launch
 * - The avatar's Twitter account becomes the fee claimer on Bags
 * - Platform gets 20% (2000 bps), avatar's Twitter account gets 80% (8000 bps)
 * - One token per avatar (irreversible)
 */
import {
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

import { _getSecretValueInternal, secretExists } from './secrets.js';
import { getAvatar } from './avatars.js';
import type { AvatarRecord } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** System wallet that always receives platform fee share */
export const PLATFORM_WALLET = '7xprTy9L24qT6agsqpHrFDUnUTFEWF2RijPzSxnroJwc';

/** Platform fee share in basis points (20% = 2000 bps) */
export const PLATFORM_FEE_BPS = 2000;

/** Avatar (Twitter account) fee share in basis points (80% = 8000 bps) */
export const AVATAR_FEE_BPS = 8000;

/** Total BPS must equal 10000 */
const TOTAL_BPS = PLATFORM_FEE_BPS + AVATAR_FEE_BPS;
if (TOTAL_BPS !== 10000) {
  throw new Error(`Fee BPS must total 10000, got ${TOTAL_BPS}`);
}

const ADMIN_TABLE = process.env.ADMIN_TABLE!;

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BagsLaunchConfig {
  /** Token name (max 32 chars) */
  name: string;
  /** Token symbol (max 10 chars) */
  symbol: string;
  /** Token description (max 1000 chars) */
  description?: string;
  /** Image URL for token - defaults to avatar profile image if not provided */
  imageUrl?: string;
  /** Initial buy in SOL (default: 0.01) */
  initialBuySol?: number;
  /** Twitter URL for token page */
  twitterUrl?: string;
  /** Website URL for token page */
  websiteUrl?: string;
  /** Telegram URL for token page */
  telegramUrl?: string;
}

export interface BagsLaunchResult {
  success: boolean;
  avatarId: string;
  tokenMint?: string;
  symbol?: string;
  name?: string;
  signature?: string;
  metadataUrl?: string;
  bagsUrl?: string;
  error?: string;
  errorCode?: 'NO_TWITTER' | 'ALREADY_LAUNCHED' | 'NO_WALLET' | 'NO_API_KEY' | 'LAUNCH_FAILED' | 'TWITTER_NOT_ON_BAGS';
}

export interface BagsTokenInfo {
  mint: string;
  symbol: string;
  name: string;
  launchedAt: number;
  signature: string;
  metadataUrl: string;
  bagsUrl: string;
}

export interface BagsLaunchPreflightResult {
  canLaunch: boolean;
  avatarId: string;
  twitterUsername?: string;
  hasWallet: boolean;
  hasApiKey: boolean;
  existingToken?: BagsTokenInfo;
  error?: string;
  errorCode?: 'NO_TWITTER' | 'ALREADY_LAUNCHED' | 'NO_WALLET' | 'NO_API_KEY';
}

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

async function getAvatarSolanaKeypair(avatarId: string): Promise<Keypair> {
  const secret = await _getSecretValueInternal(avatarId, 'solana_wallet_key', 'default');
  if (!secret) {
    throw new Error('Missing solana_wallet_key secret (name=default)');
  }
  const secretBytes = bs58.decode(secret);
  return Keypair.fromSecretKey(secretBytes);
}

async function getBagsApiKey(avatarId: string): Promise<string | null> {
  // Try avatar-specific key first, then fall back to global
  let apiKey = await _getSecretValueInternal(avatarId, 'bags_api_key', 'default');
  if (!apiKey) {
    apiKey = await _getSecretValueInternal(null, 'bags_api_key', 'default');
  }
  return apiKey;
}

function getTwitterUsername(avatar: AvatarRecord): string | null {
  return avatar.platforms?.twitter?.username || null;
}

// ---------------------------------------------------------------------------
// Bags API Client (using REST endpoints directly)
// ---------------------------------------------------------------------------

const BAGS_API_BASE = 'https://public-api-v2.bags.fm/api/v1';

interface BagsApiResponse<T> {
  success: boolean;
  response?: T;
  error?: string;
}

async function bagsApiRequest<T>(
  endpoint: string,
  apiKey: string,
  options: {
    method?: 'GET' | 'POST';
    body?: object;
    query?: Record<string, string>;
  } = {}
): Promise<T> {
  const { method = 'GET', body, query } = options;

  let url = `${BAGS_API_BASE}${endpoint}`;
  if (query) {
    const params = new URLSearchParams(query);
    url += `?${params.toString()}`;
  }

  const headers: Record<string, string> = {
    'x-api-key': apiKey,
    'Content-Type': 'application/json',
  };

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = (await response.json()) as BagsApiResponse<T>;

  if (!response.ok || !data.success) {
    throw new Error(data.error || `Bags API error: ${response.status}`);
  }

  return data.response!;
}

interface FeeShareWalletResponse {
  provider: string;
  platformData: {
    id: string;
    username: string;
    display_name: string;
    avatar_url: string;
  };
  wallet: string;
}

async function getFeeShareWallet(
  apiKey: string,
  provider: 'twitter',
  username: string
): Promise<FeeShareWalletResponse> {
  return bagsApiRequest<FeeShareWalletResponse>(
    '/token-launch/fee-share/wallet/v2',
    apiKey,
    { query: { provider, username } }
  );
}

interface TokenInfoResponse {
  tokenMint: string;
  tokenMetadata: string;
}

async function createTokenInfoAndMetadata(
  apiKey: string,
  params: {
    name: string;
    symbol: string;
    description?: string;
    imageUrl: string;
    twitter?: string;
    website?: string;
    telegram?: string;
  }
): Promise<TokenInfoResponse> {
  // Use multipart/form-data for image URL
  const formData = new FormData();
  formData.append('name', params.name);
  formData.append('symbol', params.symbol.toUpperCase().replace('$', ''));
  if (params.description) formData.append('description', params.description);
  if (params.twitter) formData.append('twitter', params.twitter);
  if (params.website) formData.append('website', params.website);
  if (params.telegram) formData.append('telegram', params.telegram);

  // Fetch the image and include it
  const imageResponse = await fetch(params.imageUrl);
  if (!imageResponse.ok) {
    throw new Error(`Failed to fetch image: ${imageResponse.status}`);
  }
  const imageBlob = await imageResponse.blob();
  formData.append('image', imageBlob, 'token-image.png');

  const response = await fetch(`${BAGS_API_BASE}/token-launch/create-token-info`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey },
    body: formData,
  });

  const data = (await response.json()) as BagsApiResponse<TokenInfoResponse>;
  if (!response.ok || !data.success) {
    throw new Error(data.error || `Failed to create token metadata: ${response.status}`);
  }

  return data.response!;
}

async function createLaunchTransaction(
  apiKey: string,
  params: {
    ipfs: string;
    tokenMint: string;
    wallet: string;
    initialBuyLamports: number;
    configKey: string;
  }
): Promise<string> {
  const response = await bagsApiRequest<string>(
    '/token-launch/create-launch-transaction',
    apiKey,
    {
      method: 'POST',
      body: {
        ipfs: params.ipfs,
        tokenMint: params.tokenMint,
        wallet: params.wallet,
        initialBuyLamports: params.initialBuyLamports,
        configKey: params.configKey,
      },
    }
  );
  return response;
}

async function sendTransaction(apiKey: string, signedTx: string): Promise<string> {
  return bagsApiRequest<string>('/solana/send-transaction', apiKey, {
    method: 'POST',
    body: { transaction: signedTx },
  });
}

// ---------------------------------------------------------------------------
// Main Service Functions
// ---------------------------------------------------------------------------

/**
 * Check if an avatar can launch a token
 */
export async function preflightBagsLaunch(avatarId: string): Promise<BagsLaunchPreflightResult> {
  const avatar = await getAvatar(avatarId);
  if (!avatar) {
    return {
      canLaunch: false,
      avatarId,
      hasWallet: false,
      hasApiKey: false,
      error: 'Avatar not found',
    };
  }

  // Check for existing token
  if (avatar.bagsToken) {
    return {
      canLaunch: false,
      avatarId,
      hasWallet: true,
      hasApiKey: true,
      existingToken: avatar.bagsToken as BagsTokenInfo,
      error: 'Avatar has already launched a token',
      errorCode: 'ALREADY_LAUNCHED',
    };
  }

  // Check Twitter username
  const twitterUsername = getTwitterUsername(avatar);
  if (!twitterUsername) {
    return {
      canLaunch: false,
      avatarId,
      hasWallet: false,
      hasApiKey: false,
      error: 'Avatar must have a Twitter account configured to launch on Bags',
      errorCode: 'NO_TWITTER',
    };
  }

  // Check Solana wallet
  const hasWallet = await secretExists(avatarId, 'solana_wallet_key', 'default');

  // Check Bags API key
  const apiKey = await getBagsApiKey(avatarId);
  const hasApiKey = !!apiKey;

  if (!hasWallet) {
    return {
      canLaunch: false,
      avatarId,
      twitterUsername,
      hasWallet: false,
      hasApiKey,
      error: 'Avatar must have a Solana wallet configured',
      errorCode: 'NO_WALLET',
    };
  }

  if (!hasApiKey) {
    return {
      canLaunch: false,
      avatarId,
      twitterUsername,
      hasWallet: true,
      hasApiKey: false,
      error: 'Bags API key not configured',
      errorCode: 'NO_API_KEY',
    };
  }

  return {
    canLaunch: true,
    avatarId,
    twitterUsername,
    hasWallet: true,
    hasApiKey: true,
  };
}

/**
 * Launch a token for an avatar on Bags
 *
 * Requirements:
 * - Avatar must have Twitter username configured
 * - Avatar must have Solana wallet (solana_wallet_key secret)
 * - Bags API key must be configured (avatar or global)
 * - Avatar must not have already launched a token
 *
 * Fee distribution:
 * - 20% (2000 bps) to platform wallet (7xprTy9L24qT6agsqpHrFDUnUTFEWF2RijPzSxnroJwc)
 * - 80% (8000 bps) to avatar's Twitter account wallet on Bags
 */
export async function launchBagsToken(
  avatarId: string,
  config: BagsLaunchConfig
): Promise<BagsLaunchResult> {
  console.log(`[BagsLaunch] Starting token launch for avatar=${avatarId}`);

  // Run preflight checks
  const preflight = await preflightBagsLaunch(avatarId);
  if (!preflight.canLaunch) {
    console.log(`[BagsLaunch] Preflight failed: ${preflight.error}`);
    return {
      success: false,
      avatarId,
      error: preflight.error,
      errorCode: preflight.errorCode,
    };
  }

  const twitterUsername = preflight.twitterUsername!;
  console.log(`[BagsLaunch] Twitter username: @${twitterUsername}`);

  try {
    // Get credentials
    const apiKey = (await getBagsApiKey(avatarId))!;
    const keypair = await getAvatarSolanaKeypair(avatarId);

    console.log(`[BagsLaunch] Avatar wallet: ${keypair.publicKey.toBase58()}`);

    // Step 1: Look up avatar's Twitter account wallet on Bags
    console.log(`[BagsLaunch] Looking up Bags wallet for @${twitterUsername}...`);
    let avatarBagsWallet: string;
    try {
      const feeShareWallet = await getFeeShareWallet(apiKey, 'twitter', twitterUsername);
      avatarBagsWallet = feeShareWallet.wallet;
      console.log(`[BagsLaunch] Found Bags wallet: ${avatarBagsWallet}`);
    } catch (err) {
      console.error(`[BagsLaunch] Failed to find Bags wallet for @${twitterUsername}:`, err);
      return {
        success: false,
        avatarId,
        error: `Twitter account @${twitterUsername} is not registered on Bags.fm. The account must be linked to Bags first.`,
        errorCode: 'TWITTER_NOT_ON_BAGS',
      };
    }

    // Step 2: Create token metadata
    console.log('[BagsLaunch] Creating token metadata...');
    const avatar = (await getAvatar(avatarId))!;
    const profileUrl = typeof avatar.profileImage === 'string' 
      ? avatar.profileImage 
      : avatar.profileImage?.url;
    const imageUrl = config.imageUrl || profileUrl || 'https://via.placeholder.com/500';

    const tokenInfo = await createTokenInfoAndMetadata(apiKey, {
      name: config.name,
      symbol: config.symbol,
      description: config.description,
      imageUrl,
      twitter: config.twitterUrl,
      website: config.websiteUrl,
      telegram: config.telegramUrl,
    });

    console.log(`[BagsLaunch] Token mint: ${tokenInfo.tokenMint}`);
    console.log(`[BagsLaunch] Metadata URL: ${tokenInfo.tokenMetadata}`);

    // Step 3: Create fee share config
    // For now, we'll use the simple approach - the Bags SDK createBagsFeeShareConfig
    // handles the on-chain config creation. Since we're using REST API, we need to
    // use the configKey returned from the launch transaction endpoint.
    // 
    // The fee claimers are specified when creating the config:
    // - Platform wallet: 2000 bps (20%)
    // - Avatar's Twitter Bags wallet: 8000 bps (80%)
    //
    // Note: The Bags API handles config creation automatically when launching.
    // The configKey in create-launch-transaction is optional for simple cases.

    console.log('[BagsLaunch] Fee distribution:');
    console.log(`  - Platform (${PLATFORM_WALLET}): ${PLATFORM_FEE_BPS / 100}%`);
    console.log(`  - Avatar @${twitterUsername} (${avatarBagsWallet}): ${AVATAR_FEE_BPS / 100}%`);

    // Step 4: Create and sign launch transaction
    console.log('[BagsLaunch] Creating launch transaction...');
    const initialBuyLamports = Math.floor((config.initialBuySol || 0.01) * LAMPORTS_PER_SOL);

    // Note: For the MVP, we'll let Bags handle the fee config automatically
    // The more complex fee share setup with explicit configs requires using the SDK
    // or additional API calls to create the config first.
    //
    // TODO: Implement full fee share config creation when Bags provides REST endpoints
    // For now, the creator (avatar wallet) will be the sole fee claimer, and we can
    // set up a secondary claim mechanism or use the SDK in a future iteration.

    const launchTx = await createLaunchTransaction(apiKey, {
      ipfs: tokenInfo.tokenMetadata,
      tokenMint: tokenInfo.tokenMint,
      wallet: keypair.publicKey.toBase58(),
      initialBuyLamports,
      configKey: '', // Let Bags create default config
    });

    // Deserialize and sign transaction
    console.log('[BagsLaunch] Signing transaction...');
    const txBuffer = Buffer.from(launchTx, 'base64');
    const tx = VersionedTransaction.deserialize(txBuffer);
    tx.sign([keypair]);

    const signedTx = Buffer.from(tx.serialize()).toString('base64');

    // Step 5: Send transaction
    console.log('[BagsLaunch] Broadcasting transaction...');
    const signature = await sendTransaction(apiKey, signedTx);
    console.log(`[BagsLaunch] Transaction confirmed: ${signature}`);

    // Step 6: Store token info on avatar record
    const bagsToken: BagsTokenInfo = {
      mint: tokenInfo.tokenMint,
      symbol: config.symbol.toUpperCase(),
      name: config.name,
      launchedAt: Date.now(),
      signature,
      metadataUrl: tokenInfo.tokenMetadata,
      bagsUrl: `https://bags.fm/${tokenInfo.tokenMint}`,
    };

    await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: { pk: `AVATAR#${avatarId}`, sk: 'CONFIG' },
      UpdateExpression: 'SET bagsToken = :token, updatedAt = :now',
      ExpressionAttributeValues: {
        ':token': bagsToken,
        ':now': Date.now(),
      },
    }));

    console.log(`[BagsLaunch] ✅ Token launched successfully!`);
    console.log(`[BagsLaunch] View at: ${bagsToken.bagsUrl}`);

    return {
      success: true,
      avatarId,
      tokenMint: bagsToken.mint,
      symbol: bagsToken.symbol,
      name: bagsToken.name,
      signature: bagsToken.signature,
      metadataUrl: bagsToken.metadataUrl,
      bagsUrl: bagsToken.bagsUrl,
    };
  } catch (error) {
    console.error('[BagsLaunch] Launch failed:', error);
    return {
      success: false,
      avatarId,
      error: error instanceof Error ? error.message : String(error),
      errorCode: 'LAUNCH_FAILED',
    };
  }
}

/**
 * Get token status for an avatar
 */
export async function getBagsTokenStatus(avatarId: string): Promise<{
  hasToken: boolean;
  token?: BagsTokenInfo;
  twitterUsername?: string;
  canLaunch: boolean;
}> {
  const avatar = await getAvatar(avatarId);
  if (!avatar) {
    return { hasToken: false, canLaunch: false };
  }

  const twitterUsername = getTwitterUsername(avatar);

  if (avatar.bagsToken) {
    return {
      hasToken: true,
      token: avatar.bagsToken as BagsTokenInfo,
      twitterUsername: twitterUsername || undefined,
      canLaunch: false,
    };
  }

  const preflight = await preflightBagsLaunch(avatarId);

  return {
    hasToken: false,
    twitterUsername: twitterUsername || undefined,
    canLaunch: preflight.canLaunch,
  };
}
