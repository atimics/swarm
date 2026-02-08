/**
 * Bags.fm Token Launch Tools
 *
 * Tools for launching tokens on Bags.fm
 * Requires:
 * - Twitter account configured on the avatar
 * - Solana wallet (solana_wallet_key secret)
 * - Bags API key (bags_api_key secret)
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

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
  hasProfileImage?: boolean;
  existingToken?: BagsTokenInfo;
  error?: string;
  errorCode?: string;
  /** Current burn tier (0-5) */
  tier?: number;
  /** Tier name (e.g., 'Spark', 'Ember', 'Inferno') */
  tierName?: string;
  /** RATI needed to burn to unlock token launch (0 if already unlocked) */
  burnNeeded?: number;
}

export interface BagsLaunchConfig {
  name: string;
  symbol: string;
  description?: string;
  imageUrl?: string;
  initialBuySol?: number;
  twitterUrl?: string;
  websiteUrl?: string;
  telegramUrl?: string;
  mintVanity?: {
    pattern?: string;
    mode?: 'best_effort' | 'strict';
    maxSearchMs?: number;
    maxAttempts?: number;
  };
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
  errorCode?: string;
  /** Current burn tier (0-5) */
  tier?: number;
  /** RATI needed to burn to unlock token launch */
  burnNeeded?: number;
  vanityPattern?: string;
  vanityMode?: 'best_effort' | 'strict';
  vanityMatched?: boolean;
  vanityPosition?: 'prefix' | 'suffix' | 'contains' | 'none';
  vanityNote?: string;
}

export interface BagsServices {
  preflightLaunch: (avatarId: string) => Promise<BagsLaunchPreflightResult>;
  launchToken: (avatarId: string, config: BagsLaunchConfig) => Promise<BagsLaunchResult>;
  getTokenStatus: (avatarId: string) => Promise<{
    hasToken: boolean;
    token?: BagsTokenInfo;
    twitterUsername?: string;
    canLaunch: boolean;
  }>;
}

// ============================================================================
// Context Builder
// ============================================================================

export async function buildBagsContext(
  services: BagsServices,
  avatarId: string
): Promise<string | undefined> {
  const status = await services.getTokenStatus(avatarId);

  if (status.hasToken && status.token) {
    return `My token: $${status.token.symbol} (${status.token.name}) - ${status.token.bagsUrl}`;
  }

  if (status.canLaunch) {
    return `No token launched yet. Can launch on Bags.fm via @${status.twitterUsername}`;
  }

  return undefined;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createBagsTools = (services: BagsServices) => [
  defineTool({
    name: 'bags_status',
    description: 'Check my Bags.fm token status. Shows if I have launched a token or if I can launch one.',
    category: 'bags',
    inputSchema: z.object({}),
    contextBuilder: async (context) => {
      return buildBagsContext(services, context.avatarId);
    },
    execute: async (_input, context): Promise<ToolResult> => {
      const status = await services.getTokenStatus(context.avatarId);

      if (status.hasToken && status.token) {
        return {
          success: true,
          data: {
            hasToken: true,
            token: {
              mint: status.token.mint,
              symbol: status.token.symbol,
              name: status.token.name,
              bagsUrl: status.token.bagsUrl,
              launchedAt: new Date(status.token.launchedAt).toISOString(),
            },
            canLaunch: false,
          },
        };
      }

      // Check if can launch
      const preflight = await services.preflightLaunch(context.avatarId);

      return {
        success: true,
        data: {
          hasToken: false,
          canLaunch: preflight.canLaunch,
          twitterUsername: preflight.twitterUsername,
          hasWallet: preflight.hasWallet,
          hasApiKey: preflight.hasApiKey,
          tier: preflight.tier,
          tierName: preflight.tierName,
          burnNeeded: preflight.burnNeeded,
          error: preflight.error,
          errorCode: preflight.errorCode,
        },
      };
    },
  }),

  defineTool({
    name: 'bags_launch',
    description:
      'Launch my token on Bags.fm. IMPORTANT: This is irreversible - I can only launch ONE token ever. ' +
      'Requires: Twitter account configured, Solana wallet, Bags API key. ' +
      'Fee distribution: 80% to my Twitter account\'s Bags wallet, 20% to platform.',
    category: 'bags',
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .max(32)
        .describe('Token name (1-32 characters)'),
      symbol: z
        .string()
        .min(1)
        .max(10)
        .describe('Token symbol (1-10 characters, e.g., "VIBE")'),
      description: z
        .string()
        .max(1000)
        .optional()
        .describe('Token description (max 1000 characters)'),
      imageUrl: z
        .string()
        .url()
        .optional()
        .describe('Token image URL (defaults to my profile image)'),
      initialBuySol: z
        .number()
        .positive()
        .max(10)
        .default(0.01)
        .describe('Initial buy amount in SOL (default: 0.01)'),
      twitterUrl: z
        .string()
        .url()
        .optional()
        .describe('Twitter URL for token page'),
      websiteUrl: z
        .string()
        .url()
        .optional()
        .describe('Website URL for token page'),
      telegramUrl: z
        .string()
        .url()
        .optional()
        .describe('Telegram URL for token page'),
      mintVanity: z
        .object({
          pattern: z
            .string()
            .min(1)
            .optional()
            .describe('Base58 vanity pattern, e.g. "RATi"'),
          mode: z
            .enum(['best_effort', 'strict'])
            .default('best_effort')
            .describe('best_effort=allow any contains match; strict=prefix/suffix only'),
          maxSearchMs: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Native engine search budget in milliseconds'),
          maxAttempts: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Native engine search budget in attempts'),
        })
        .optional()
        .describe('Optional vanity mint policy'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      // Run preflight check first
      const preflight = await services.preflightLaunch(context.avatarId);

      if (!preflight.canLaunch) {
        return {
          success: false,
          error: preflight.error,
          data: {
            errorCode: preflight.errorCode,
            tier: preflight.tier,
            tierName: preflight.tierName,
            burnNeeded: preflight.burnNeeded,
            existingToken: preflight.existingToken
              ? {
                  mint: preflight.existingToken.mint,
                  symbol: preflight.existingToken.symbol,
                  bagsUrl: preflight.existingToken.bagsUrl,
                }
              : undefined,
          },
        };
      }

      // Launch the token
      const result = await services.launchToken(context.avatarId, {
        name: input.name,
        symbol: input.symbol,
        description: input.description,
        imageUrl: input.imageUrl,
        initialBuySol: input.initialBuySol,
        twitterUrl: input.twitterUrl,
        websiteUrl: input.websiteUrl,
        telegramUrl: input.telegramUrl,
        mintVanity: input.mintVanity,
      });

      if (!result.success) {
        return {
          success: false,
          error: result.error,
          data: {
            errorCode: result.errorCode,
            vanityPattern: result.vanityPattern,
            vanityMode: result.vanityMode,
            vanityMatched: result.vanityMatched,
            vanityPosition: result.vanityPosition,
            vanityNote: result.vanityNote,
          },
        };
      }

      return {
        success: true,
        data: {
          token: {
            mint: result.tokenMint,
            symbol: result.symbol,
            name: result.name,
            bagsUrl: result.bagsUrl,
            signature: result.signature,
          },
          vanity: result.vanityPattern
            ? {
                pattern: result.vanityPattern,
                mode: result.vanityMode,
                matched: result.vanityMatched,
                position: result.vanityPosition,
                note: result.vanityNote,
              }
            : undefined,
          message: `🚀 Token $${result.symbol} launched successfully! View at ${result.bagsUrl}`,
        },
      };
    },
  }),

  defineTool({
    name: 'bags_preflight',
    description:
      'Check if I can launch a token on Bags.fm without actually launching. ' +
      'Shows requirements status: Twitter account, Solana wallet, API key, and burn tier.',
    category: 'bags',
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      const preflight = await services.preflightLaunch(context.avatarId);

      return {
        success: true,
        data: {
          canLaunch: preflight.canLaunch,
          requirements: {
            twitterAccount: {
              configured: !!preflight.twitterUsername,
              username: preflight.twitterUsername,
            },
            profileImage: {
              configured: preflight.hasProfileImage !== false,
            },
            solanaWallet: {
              configured: preflight.hasWallet,
            },
            bagsApiKey: {
              configured: preflight.hasApiKey,
            },
            burnTier: {
              tier: preflight.tier,
              tierName: preflight.tierName,
              requiredTier: 3,
              requiredTierName: 'Inferno',
              unlocked: preflight.tier !== undefined && preflight.tier >= 3,
              burnNeeded: preflight.burnNeeded ?? 0,
            },
          },
          existingToken: preflight.existingToken
            ? {
                mint: preflight.existingToken.mint,
                symbol: preflight.existingToken.symbol,
                bagsUrl: preflight.existingToken.bagsUrl,
              }
            : null,
          error: preflight.error,
          errorCode: preflight.errorCode,
        },
      };
    },
  }),
];

export default createBagsTools;
