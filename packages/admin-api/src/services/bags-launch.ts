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
  type Commitment,
  Keypair,
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import {
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  evaluateVanityMatch,
  resolveVanityMintConfig,
  type VanityMatchPosition,
  type VanityMintConfig,
  type VanityMintMode,
} from './vanity-mint.js';

import { _getSecretValueInternal, secretExists } from './secrets.js';
import { getAvatar } from './avatars.js';
import { canLaunchToken } from './burn-stats.js';
import { BURN_TIERS } from '@swarm/core';
import type { AvatarRecord } from '../types.js';
import { getDynamoClient } from './dynamo-client.js';

// ---------------------------------------------------------------------------
// Tier Helper
// ---------------------------------------------------------------------------

/**
 * Get tier name by tier number
 */
function getTierName(tier: number): string {
  const burnTier = BURN_TIERS.find(t => t.tier === tier);
  return burnTier?.name ?? 'Unknown';
}

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

const dynamoClient = getDynamoClient();

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
  /**
   * Optional vanity mint policy.
   *
   * strict:
   * - requires mint to start or end with pattern
   *
   * best_effort:
   * - attempts to match pattern anywhere
   */
  mintVanity?: VanityMintConfig;
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
  errorCode?: 'NO_TWITTER' | 'ALREADY_LAUNCHED' | 'NO_WALLET' | 'NO_API_KEY' | 'NO_PROFILE_IMAGE' | 'LAUNCH_FAILED' | 'TWITTER_NOT_ON_BAGS' | 'INSUFFICIENT_TIER';
  /** Current burn tier (0-5) */
  tier?: number;
  /** RATI needed to burn to unlock token launch */
  burnNeeded?: number;
  /** Vanity pattern evaluated against the resulting mint (if requested) */
  vanityPattern?: string;
  /** Vanity policy used (if requested) */
  vanityMode?: VanityMintMode;
  /** Whether resulting mint satisfied vanity policy */
  vanityMatched?: boolean;
  /** Where the pattern matched in resulting mint */
  vanityPosition?: VanityMatchPosition;
  /** Additional note about vanity execution */
  vanityNote?: string;
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
  errorCode?: 'NO_TWITTER' | 'ALREADY_LAUNCHED' | 'NO_WALLET' | 'NO_API_KEY' | 'NO_PROFILE_IMAGE' | 'INSUFFICIENT_TIER';
  /** Current burn tier (0-5) */
  tier?: number;
  /** Tier name (e.g., 'Spark', 'Ember', 'Inferno') */
  tierName?: string;
  /** RATI needed to burn to unlock token launch (0 if already unlocked) */
  burnNeeded?: number;
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
// Bags API + Solana Helpers
// ---------------------------------------------------------------------------

/** Default Solana RPC URL (can be overridden via env) */
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

/** Default Bags public API URL (can be overridden via env) */
const BAGS_PUBLIC_API_V2_BASE_URL = process.env.BAGS_API_BASE_URL || 'https://public-api-v2.bags.fm/api/v1';

/** Bags fee-share-v2 on-chain program id used for partner PDA derivation */
const BAGS_FEE_SHARE_V2_PROGRAM_ID = 'FEE2tBhCKAt7shrod19QttSVREUYPiyMzoku1mL1gqVK';

const SOLANA_COMMITMENT: Commitment = 'processed';
const TOKEN_LAUNCH_ENGINE = process.env.TOKEN_LAUNCH_ENGINE || 'bags_external';

type BagsSupportedLaunchProvider = 'twitter' | 'tiktok' | 'kick' | 'github';

type BagsApiSuccess<T> = {
  success: true;
  response: T;
};

type BagsApiFailure = {
  success: false;
  error: string;
};

type BagsApiEnvelope<T> = BagsApiSuccess<T> | BagsApiFailure;

interface BagsLaunchWalletResponse {
  provider: string;
  platformData: unknown;
  wallet: string;
}

interface BagsCreateTokenInfoResponse {
  tokenMint: string;
  tokenMetadata: string;
}

interface BagsTransactionWithBlockhash {
  transaction: string;
  blockhash: {
    blockhash: string;
    lastValidBlockHeight: number;
  };
}

interface BagsCreateFeeShareConfigResponse {
  needsCreation: boolean;
  feeShareAuthority: string;
  meteoraConfigKey?: string;
  transactions?: BagsTransactionWithBlockhash[];
  bundles?: BagsTransactionWithBlockhash[][];
}

interface BagsCreateFeeShareConfigParams {
  feeClaimers: Array<{ user: PublicKey; userBps: number }>;
  payer: PublicKey;
  baseMint: PublicKey;
  partner?: PublicKey;
  partnerConfig?: PublicKey;
  additionalLookupTables?: PublicKey[];
}

interface BagsCreateLaunchTransactionParams {
  metadataUrl: string;
  tokenMint: PublicKey;
  launchWallet: PublicKey;
  initialBuyLamports: number;
  configKey: PublicKey;
}

interface BagsCreateFeeShareConfigResult {
  transactions: VersionedTransaction[];
  bundles: VersionedTransaction[][];
  meteoraConfigKey: PublicKey;
}

function deriveBagsFeeShareV2PartnerConfigPda(partner: PublicKey): PublicKey {
  const [partnerConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('partner_config'), partner.toBuffer()],
    new PublicKey(BAGS_FEE_SHARE_V2_PROGRAM_ID)
  );
  return partnerConfig;
}

function buildBagsApiUrl(path: string, query?: Record<string, string>): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${BAGS_PUBLIC_API_V2_BASE_URL}${normalizedPath}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function getBagsApiErrorMessage(status: number, payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === 'string' && error.length > 0) return error;

    const message = (payload as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return `Bags API request failed with status ${status}`;
}

async function parseBagsResponsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

async function bagsApiRequest<T>(
  apiKey: string,
  path: string,
  init: RequestInit = {},
  query?: Record<string, string>
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-api-key', apiKey);

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), 60_000);

  try {
    const response = await fetch(buildBagsApiUrl(path, query), {
      ...init,
      headers,
      signal: timeoutController.signal,
    });

    const payload = await parseBagsResponsePayload(response);

    if (!response.ok) {
      throw new Error(getBagsApiErrorMessage(response.status, payload));
    }

    if (typeof payload !== 'object' || payload === null || !('success' in payload)) {
      throw new Error('Unexpected Bags API response format');
    }

    const envelope = payload as BagsApiEnvelope<T>;
    if (envelope.success) {
      return envelope.response;
    }

    throw new Error(envelope.error || 'Bags API request failed');
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Bags API request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getLaunchWalletV2(
  apiKey: string,
  username: string,
  provider: BagsSupportedLaunchProvider
): Promise<PublicKey> {
  const response = await bagsApiRequest<BagsLaunchWalletResponse>(
    apiKey,
    '/token-launch/fee-share/wallet/v2',
    { method: 'GET' },
    { username, provider }
  );
  return new PublicKey(response.wallet);
}

async function createTokenInfoAndMetadata(
  apiKey: string,
  params: {
    imageUrl: string;
    name: string;
    symbol: string;
    description: string;
    twitter?: string;
    website?: string;
    telegram?: string;
  }
): Promise<BagsCreateTokenInfoResponse> {
  const form = new FormData();
  form.append('imageUrl', params.imageUrl);
  form.append('name', params.name);
  form.append('symbol', params.symbol);
  form.append('description', params.description);

  if (params.twitter) form.append('twitter', params.twitter);
  if (params.website) form.append('website', params.website);
  if (params.telegram) form.append('telegram', params.telegram);

  return bagsApiRequest<BagsCreateTokenInfoResponse>(apiKey, '/token-launch/create-token-info', {
    method: 'POST',
    body: form,
  });
}

async function createBagsFeeShareConfig(
  apiKey: string,
  params: BagsCreateFeeShareConfigParams
): Promise<BagsCreateFeeShareConfigResult> {
  const totalBps = params.feeClaimers.reduce((sum, claimer) => sum + claimer.userBps, 0);
  if (totalBps !== 10000) {
    throw new Error(`Total BPS must be 10000, got ${totalBps}`);
  }

  if ((params.partner && !params.partnerConfig) || (!params.partner && params.partnerConfig)) {
    throw new Error('partner and partnerConfig must be provided together');
  }

  const response = await bagsApiRequest<BagsCreateFeeShareConfigResponse>(
    apiKey,
    '/fee-share/config',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        basisPointsArray: params.feeClaimers.map((claimer) => claimer.userBps),
        payer: params.payer.toBase58(),
        baseMint: params.baseMint.toBase58(),
        partner: params.partner?.toBase58(),
        partnerConfig: params.partnerConfig?.toBase58(),
        claimersArray: params.feeClaimers.map((claimer) => claimer.user.toBase58()),
        additionalLookupTables: params.additionalLookupTables?.map((lookupTable) => lookupTable.toBase58()),
      }),
    }
  );

  if (!response.needsCreation) {
    throw new Error('Config already exists');
  }

  if (!response.meteoraConfigKey) {
    throw new Error('Bags API response missing meteoraConfigKey');
  }

  return {
    transactions: (response.transactions ?? []).map(({ transaction }) =>
      VersionedTransaction.deserialize(bs58.decode(transaction))
    ),
    bundles: (response.bundles ?? []).map((bundle) =>
      bundle.map(({ transaction }) => VersionedTransaction.deserialize(bs58.decode(transaction)))
    ),
    meteoraConfigKey: new PublicKey(response.meteoraConfigKey),
  };
}

async function createLaunchTransaction(
  apiKey: string,
  params: BagsCreateLaunchTransactionParams
): Promise<VersionedTransaction> {
  const encodedTransaction = await bagsApiRequest<string>(
    apiKey,
    '/token-launch/create-launch-transaction',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ipfs: params.metadataUrl,
        tokenMint: params.tokenMint.toBase58(),
        wallet: params.launchWallet.toBase58(),
        initialBuyLamports: params.initialBuyLamports,
        configKey: params.configKey.toBase58(),
      }),
    }
  );

  return VersionedTransaction.deserialize(bs58.decode(encodedTransaction));
}

async function signAndSendTransaction(
  connection: Connection,
  commitment: Commitment,
  transaction: VersionedTransaction,
  keypair: Keypair
): Promise<string> {
  transaction.sign([keypair]);

  const latestBlockhash = await connection.getLatestBlockhash(commitment);
  const signature = await connection.sendTransaction(transaction, {
    skipPreflight: true,
    maxRetries: 0,
  });

  const confirmed = await connection.confirmTransaction(
    {
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      signature,
    },
    commitment
  );

  if (confirmed.value.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(confirmed.value.err)}`);
  }

  return signature;
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

  // Check burn tier requirement (Tier 3 / Inferno required for token launch)
  const tierCheck = await canLaunchToken(avatarId);
  if (!tierCheck.allowed) {
    return {
      canLaunch: false,
      avatarId,
      twitterUsername,
      hasProfileImage: true,
      hasWallet: true,
      hasApiKey: true,
      error: tierCheck.error,
      errorCode: 'INSUFFICIENT_TIER',
      tier: tierCheck.tier,
      tierName: getTierName(tierCheck.tier),
      burnNeeded: tierCheck.burnNeeded,
    };
  }

  return {
    canLaunch: true,
    avatarId,
    twitterUsername,
    hasProfileImage: true,
    hasWallet: true,
    hasApiKey: true,
    tier: tierCheck.tier,
    tierName: getTierName(tierCheck.tier),
    burnNeeded: 0,
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

  let vanityConfig;
  try {
    vanityConfig = resolveVanityMintConfig(config.mintVanity);
  } catch (error) {
    return {
      success: false,
      avatarId,
      error: error instanceof Error ? error.message : 'Invalid vanity mint config',
      errorCode: 'LAUNCH_FAILED',
    };
  }

  if (vanityConfig?.mode === 'strict' && TOKEN_LAUNCH_ENGINE !== 'swarm_native') {
    return {
      success: false,
      avatarId,
      error:
        'Strict vanity mint policy requires native launch engine. ' +
        `Current engine: ${TOKEN_LAUNCH_ENGINE}`,
      errorCode: 'LAUNCH_FAILED',
      vanityPattern: vanityConfig.pattern,
      vanityMode: vanityConfig.mode,
      vanityMatched: false,
      vanityPosition: 'none',
      vanityNote: 'Strict mode is only supported on the native launch engine.',
    };
  }

  // Run preflight checks (includes tier requirement check)
  const preflight = await preflightBagsLaunch(avatarId);
  if (!preflight.canLaunch) {
    console.log(`[BagsLaunch] Preflight failed: ${preflight.error}`);
    return {
      success: false,
      avatarId,
      error: preflight.error,
      errorCode: preflight.errorCode,
      tier: preflight.tier,
      burnNeeded: preflight.burnNeeded,
      vanityPattern: vanityConfig?.pattern,
      vanityMode: vanityConfig?.mode,
    };
  }

  const twitterUsername = preflight.twitterUsername!;
  console.log(`[BagsLaunch] Twitter username: @${twitterUsername}`);

  try {
    // Get credentials
    const apiKey = (await getBagsApiKey(avatarId))!;
    const keypair = await getAvatarSolanaKeypair(avatarId);
    const commitment = SOLANA_COMMITMENT;
    const connection = new Connection(SOLANA_RPC_URL);

    console.log(`[BagsLaunch] Avatar wallet: ${keypair.publicKey.toBase58()}`);

    // Step 1: Look up avatar's Twitter account wallet on Bags API
    console.log(`[BagsLaunch] Looking up Bags wallet for @${twitterUsername}...`);
    let avatarBagsWallet: PublicKey;
    try {
      avatarBagsWallet = await getLaunchWalletV2(apiKey, twitterUsername, 'twitter');
      console.log(`[BagsLaunch] Found Bags wallet: ${avatarBagsWallet.toBase58()}`);
    } catch (err) {
      console.error(`[BagsLaunch] Failed to find Bags wallet for @${twitterUsername}:`, err);
      return {
        success: false,
        avatarId,
        error: `Twitter account @${twitterUsername} is not registered on Bags.fm. The account must be linked to Bags first.`,
        errorCode: 'TWITTER_NOT_ON_BAGS',
        vanityPattern: vanityConfig?.pattern,
        vanityMode: vanityConfig?.mode,
      };
    }

    // Step 2: Create token metadata using Bags API
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
        vanityPattern: vanityConfig?.pattern,
        vanityMode: vanityConfig?.mode,
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
        vanityPattern: vanityConfig?.pattern,
        vanityMode: vanityConfig?.mode,
      };
    }

    // Use avatar description as fallback for token description
    const tokenDescription = config.description || avatar.description || `${config.name} - launched by @${twitterUsername}`;

    const tokenInfo = await createTokenInfoAndMetadata(apiKey, {
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
    const vanityMatch = vanityConfig ? evaluateVanityMatch(tokenInfo.tokenMint, vanityConfig) : null;
    const vanityNote = vanityConfig
      ? vanityMatch?.matched
        ? `Mint matched vanity policy (${vanityConfig.mode}).`
        : vanityConfig.mode === 'best_effort'
          ? `Mint did not match "${vanityConfig.pattern}". Launch continued due to best-effort policy.`
          : undefined
      : undefined;
    if (vanityNote) {
      console.log(`[BagsLaunch] ${vanityNote}`);
    }

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

    const configResult = await createBagsFeeShareConfig(apiKey, {
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

    // Step 4: Create launch transaction using Bags API
    console.log('[BagsLaunch] Creating launch transaction...');
    const initialBuyLamports = Math.floor((config.initialBuySol || 0.01) * LAMPORTS_PER_SOL);

    const launchTx = await createLaunchTransaction(apiKey, {
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
      vanityPattern: vanityConfig?.pattern,
      vanityMode: vanityConfig?.mode,
      vanityMatched: vanityMatch?.matched,
      vanityPosition: vanityMatch?.position,
      vanityNote,
    };
  } catch (error) {
    console.error('[BagsLaunch] Launch failed:', error);
    return {
      success: false,
      avatarId,
      error: error instanceof Error ? error.message : String(error),
      errorCode: 'LAUNCH_FAILED',
      vanityPattern: vanityConfig?.pattern,
      vanityMode: vanityConfig?.mode,
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
