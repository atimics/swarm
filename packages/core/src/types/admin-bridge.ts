/**
 * Admin Bridge Types
 *
 * Shared types that both @swarm/handlers (runtime plane) and @swarm/admin-api
 * (control plane) need. Living in core avoids an inverted dependency where
 * handlers would import from admin-api.
 */

// =============================================================================
// Bags Token Launch Types
// =============================================================================

export type VanityMintMode = 'best_effort' | 'strict';
export type VanityMatchPosition = 'prefix' | 'suffix' | 'contains' | 'none';

export interface VanityMintConfig {
  /**
   * Base58 pattern to target in the resulting mint.
   * Example: "RATi"
   */
  pattern?: string;
  /**
   * strict:
   * - mint must start or end with pattern
   *
   * best_effort:
   * - mint can contain pattern anywhere
   */
  mode?: VanityMintMode;
  /**
   * Native engine budget (milliseconds) for searching vanity mints.
   * Ignored by external launch providers.
   */
  maxSearchMs?: number;
  /**
   * Native engine budget (attempt count) for searching vanity mints.
   * Ignored by external launch providers.
   */
  maxAttempts?: number;
}

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
  /** Optional vanity mint policy */
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
  /** Vanity pattern evaluated against resulting mint (if requested) */
  vanityPattern?: string;
  /** Vanity mode used (if requested) */
  vanityMode?: VanityMintMode;
  /** Whether resulting mint satisfied vanity policy */
  vanityMatched?: boolean;
  /** Where the pattern matched in resulting mint */
  vanityPosition?: VanityMatchPosition;
  /** Additional note about vanity handling */
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

export interface BagsTokenStatus {
  hasToken: boolean;
  token?: BagsTokenInfo;
  twitterUsername?: string;
  canLaunch: boolean;
}

/**
 * Interface for Bags token launch operations.
 * Implementations live in admin-api; handlers depends only on this interface.
 */
export interface BagsService {
  preflightBagsLaunch: (avatarId: string) => Promise<BagsLaunchPreflightResult>;
  launchBagsToken: (avatarId: string, config: BagsLaunchConfig) => Promise<BagsLaunchResult>;
  getBagsTokenStatus: (avatarId: string) => Promise<BagsTokenStatus>;
}

// =============================================================================
// Telegram Admin Avatar Types
// =============================================================================

/**
 * Parameters for creating an avatar from the Telegram admin bot flow.
 */
export interface CreateAvatarFromTelegramParams {
  /** Bot token from BotFather */
  botToken: string;
  /** Bot username (without @) */
  botUsername: string;
  /** Bot ID (numeric) */
  botId: number;
  /** Display name for the avatar */
  name: string;
  /** Optional description */
  description?: string;
  /** Optional persona/personality */
  persona?: string;
  /** Telegram user ID of the creator */
  telegramUserId: string;
  /** Telegram username of the creator (without @) */
  telegramUsername?: string;
}

/**
 * Result of creating an avatar from Telegram.
 */
export interface CreateAvatarFromTelegramResult {
  success: boolean;
  avatarId?: string;
  avatar?: Record<string, unknown>;
  error?: 'token_already_used' | 'name_taken' | 'webhook_failed' | 'unknown';
  message?: string;
}

/**
 * Interface for admin-api avatar operations needed by handlers.
 * Implementations live in admin-api; handlers depends only on this interface.
 */
export interface AdminAvatarOperations {
  createAvatarFromTelegram: (params: CreateAvatarFromTelegramParams) => Promise<CreateAvatarFromTelegramResult>;
  getAvatar: (avatarId: string) => Promise<Record<string, unknown> | null>;
  updateAvatarFromTelegram: (avatarId: string, updates: { name?: string; description?: string; persona?: string }, by: string) => Promise<unknown>;
}
