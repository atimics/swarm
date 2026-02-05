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
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  BagsSDK,
  signAndSendTransaction,
} from '@bagsfm/bags-sdk';
import { deriveBagsFeeShareV2PartnerConfigPda } from '@bagsfm/bags-sdk/dist/utils/fee-share-v2/partner-config.js';
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
  errorCode?: 'NO_TWITTER' | 'ALREADY_LAUNCHED' | 'NO_WALLET' | 'NO_API_KEY' | 'NO_PROFILE_IMAGE' | 'LAUNCH_FAILED' | 'TWITTER_NOT_ON_BAGS';
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
  hasProfileImage: boolean;
  hasWallet: boolean;
  hasApiKey: boolean;
  existingToken?: BagsTokenInfo;
  error?: string;
  errorCode?: 'NO_TWITTER' | 'ALREADY_LAUNCHED' | 'NO_WALLET' | 'NO_API_KEY' | 'NO_PROFILE_IMAGE';
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

async function getBagsPartnerKey(): Promise<string | null> {
  // Partner key is global only (platform-level)
  return _getSecretValueInternal(null, 'bags_partner_key', 'default');
}

function getTwitterUsername(avatar: AvatarRecord): string | null {
  return avatar.platforms?.twitter?.username || null;
}

// ---------------------------------------------------------------------------
// SDK Initialization
// ---------------------------------------------------------------------------

/** Default Solana RPC URL (can be overridden via env) */
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

/**
 * Create a configured BagsSDK instance
 */
function createBagsSDK(apiKey: string): BagsSDK {
  const connection = new Connection(SOLANA_RPC_URL);
  return new BagsSDK(apiKey, connection, 'processed');
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
      hasProfileImage: false,
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
      hasProfileImage: true,
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
      hasProfileImage: false,
      hasWallet: false,
      hasApiKey: false,
      error: 'Avatar must have a Twitter account configured to launch on Bags',
      errorCode: 'NO_TWITTER',
    };
  }

  // Check profile image
  const profileUrl = typeof avatar.profileImage === 'string'
    ? avatar.profileImage
    : avatar.profileImage?.url;
  if (!profileUrl) {
    return {
      canLaunch: false,
      avatarId,
      twitterUsername,
      hasProfileImage: false,
      hasWallet: false,
      hasApiKey: false,
      error: 'Avatar must have a profile image set before launching a token',
      errorCode: 'NO_PROFILE_IMAGE',
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
      hasProfileImage: true,
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
      hasProfileImage: true,
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
    hasProfileImage: true,
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
    const sdk = createBagsSDK(apiKey);
    const commitment = sdk.state.getCommitment();
    const connection = new Connection(SOLANA_RPC_URL);

    console.log(`[BagsLaunch] Avatar wallet: ${keypair.publicKey.toBase58()}`);

    // Step 1: Look up avatar's Twitter account wallet on Bags using SDK
    console.log(`[BagsLaunch] Looking up Bags wallet for @${twitterUsername}...`);
    let avatarBagsWallet: PublicKey;
    try {
      const feeShareWallet = await sdk.state.getLaunchWalletV2(twitterUsername, 'twitter');
      avatarBagsWallet = feeShareWallet.wallet;
      console.log(`[BagsLaunch] Found Bags wallet: ${avatarBagsWallet.toBase58()}`);
    } catch (err) {
      console.error(`[BagsLaunch] Failed to find Bags wallet for @${twitterUsername}:`, err);
      return {
        success: false,
        avatarId,
        error: `Twitter account @${twitterUsername} is not registered on Bags.fm. The account must be linked to Bags first.`,
        errorCode: 'TWITTER_NOT_ON_BAGS',
      };
    }

    // Step 2: Create token metadata using SDK
    console.log('[BagsLaunch] Creating token metadata...');
    const avatar = (await getAvatar(avatarId))!;
    const profileUrl = typeof avatar.profileImage === 'string'
      ? avatar.profileImage
      : avatar.profileImage?.url;

    // Require a proper image - don't launch with placeholder
    const imageUrl = config.imageUrl || profileUrl;
    if (!imageUrl) {
      return {
        success: false,
        avatarId,
        error: 'Avatar must have a profile image set before launching a token. Use the profile image tool first.',
        errorCode: 'LAUNCH_FAILED',
      };
    }

    // Sanitize symbol: uppercase, strip $, alphanumeric only
    const sanitizedSymbol = config.symbol
      .toUpperCase()
      .replace(/^\$/, '')
      .replace(/[^A-Z0-9]/g, '');

    if (sanitizedSymbol.length === 0 || sanitizedSymbol.length > 10) {
      return {
        success: false,
        avatarId,
        error: 'Token symbol must be 1-10 alphanumeric characters',
        errorCode: 'LAUNCH_FAILED',
      };
    }

    // Use avatar description as fallback for token description
    const tokenDescription = config.description || avatar.description || `${config.name} - launched by @${twitterUsername}`;

    const tokenInfo = await sdk.tokenLaunch.createTokenInfoAndMetadata({
      imageUrl,
      name: config.name.trim(),
      description: tokenDescription,
      symbol: sanitizedSymbol,
      twitter: config.twitterUrl,
      website: config.websiteUrl,
      telegram: config.telegramUrl,
    });

    const tokenMint = new PublicKey(tokenInfo.tokenMint);
    console.log(`[BagsLaunch] Token mint: ${tokenMint.toBase58()}`);
    console.log(`[BagsLaunch] Metadata URL: ${tokenInfo.tokenMetadata}`);

    // Step 3: Create fee share config with proper distribution
    // - Platform wallet: 2000 bps (20%)
    // - Avatar's Twitter Bags wallet: 8000 bps (80%)
    // - Partner receives additional fees from Bags (separate from above)
    console.log('[BagsLaunch] Creating fee share configuration...');
    console.log(`  - Platform (${PLATFORM_WALLET}): ${PLATFORM_FEE_BPS / 100}%`);
    console.log(`  - Avatar @${twitterUsername} (${avatarBagsWallet.toBase58()}): ${AVATAR_FEE_BPS / 100}%`);

    const platformWallet = new PublicKey(PLATFORM_WALLET);
    const feeClaimers = [
      { user: avatarBagsWallet, userBps: AVATAR_FEE_BPS },   // 80% to avatar's Twitter wallet
      { user: platformWallet, userBps: PLATFORM_FEE_BPS },   // 20% to platform
    ];

    // Get partner key if configured (for platform-level partner fees)
    const partnerKeyStr = await getBagsPartnerKey();
    let partner: PublicKey | undefined;
    let partnerConfig: PublicKey | undefined;
    
    if (partnerKeyStr) {
      partner = new PublicKey(partnerKeyStr);
      partnerConfig = deriveBagsFeeShareV2PartnerConfigPda(partner);
      console.log(`[BagsLaunch] Using partner key: ${partner.toBase58()}`);
      console.log(`[BagsLaunch] Partner config PDA: ${partnerConfig.toBase58()}`);
    }

    const configResult = await sdk.config.createBagsFeeShareConfig({
      payer: keypair.publicKey,
      baseMint: tokenMint,
      feeClaimers,
      partner,
      partnerConfig,
    });

    // Sign and send config creation transactions
    for (const tx of configResult.transactions || []) {
      await signAndSendTransaction(connection, commitment, tx, keypair);
    }

    // Handle bundles if present (for large fee claimer sets)
    if (configResult.bundles && configResult.bundles.length > 0) {
      console.log(`[BagsLaunch] Sending ${configResult.bundles.length} bundle(s)...`);
      for (const bundle of configResult.bundles) {
        for (const tx of bundle) {
          tx.sign([keypair]);
          // Send via SDK's Jito integration if available
          await signAndSendTransaction(connection, commitment, tx, keypair);
        }
      }
    }

    console.log(`[BagsLaunch] Config key: ${configResult.meteoraConfigKey.toBase58()}`);

    // Step 4: Create and sign launch transaction using SDK
    console.log('[BagsLaunch] Creating launch transaction...');
    const initialBuyLamports = Math.floor((config.initialBuySol || 0.01) * LAMPORTS_PER_SOL);

    const launchTx = await sdk.tokenLaunch.createLaunchTransaction({
      metadataUrl: tokenInfo.tokenMetadata,
      tokenMint,
      launchWallet: keypair.publicKey,
      initialBuyLamports,
      configKey: configResult.meteoraConfigKey,
    });

    // Step 5: Sign and send launch transaction
    console.log('[BagsLaunch] Signing and broadcasting transaction...');
    const signature = await signAndSendTransaction(connection, commitment, launchTx, keypair);
    console.log(`[BagsLaunch] Transaction confirmed: ${signature}`);

    // Step 6: Store token info on avatar record
    const bagsToken: BagsTokenInfo = {
      mint: tokenInfo.tokenMint,
      symbol: sanitizedSymbol,
      name: config.name.trim(),
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
