/**
 * NFT Tools
 *
 * Avatar-facing tools for inhabitation awareness.
 *
 * IMPORTANT: Avatars should NOT have power to:
 * - Inhabit/abandon avatars (user action via wallet)
 * - See all unclaimed avatars (user browses via UI)
 * - Burn NFTs or mint NFTs (user action via wallet)
 *
 * Avatars CAN:
 * - Check if they are currently inhabited
 * - Generate a link for users to inhabit them
 * - Know their own lineage/era history
 */
import { z } from 'zod';
import { defineReadonlyTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

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

export interface InhabitationInfo {
  isGhost: boolean;
  inhabitsAvatar: boolean;
  avatarId?: string;
  avatarName?: string;
  avatarUrl?: string;
  era?: number;
  gateStatus?: GateStatus;
}

export interface UnclaimedAvatar {
  avatarId: string;
  name: string;
  description?: string;
  avatarUrl?: string;
  era: number;
}

export interface InhabitResult {
  success: boolean;
  error?: string;
  avatarId?: string;
  avatarName?: string;
  avatarUrl?: string;
  era?: number;
}

export interface AbandonResult {
  success: boolean;
  error?: string;
  avatarId?: string;
  avatarName?: string;
  era?: number;
  lineageNftMint?: string;
  burnedMint?: string;
  gateStatus?: GateStatus;
}

export interface BurnVerification {
  verified: boolean;
  signature?: string;
  burnedMint?: string;
  error?: string;
}

export interface LineageMetadata {
  avatarId: string;
  avatarName: string;
  era: number;
  isGenesis: boolean;
  abandonedAt: number;
  inhabitantWallet: string;
  avatarUrl?: string;
  snapshotUrl?: string;
}

export interface MintPreparation {
  success: boolean;
  metadata?: LineageMetadata;
  collectionMint?: string;
  error?: string;
}

export interface LineageCollection {
  avatarId: string;
  collectionMint: string;
  createdAt: number;
  totalMinted: number;
}

export interface AvatarInhabitationStatus {
  isInhabited: boolean;
  inhabitantWallet?: string;
  inhabitedAt?: number;
  currentEra: number;
  totalEras: number; // How many times this avatar has been abandoned
}

// NFT Collection Avatar types
export interface ClaimableNFT {
  mint: string;
  name: string;
  image: string;
  collection: string;
  collectionName?: string;
  // Rich metadata from off-chain JSON
  description?: string;      // Character description/backstory
  personality?: string;      // Personality trait (for avatar persona)
  attributes?: Array<{       // All NFT attributes
    trait_type: string;
    value: string;
  }>;
}

export interface ClaimNFTResult {
  success: boolean;
  error?: string;
  avatarId?: string;
  avatarName?: string;
  avatarImage?: string;
}

export interface AvatarAscensionStatus {
  isAscended: boolean;
  ascendedAt?: number;
  ascendedNftMint?: string;
  ascendedByWallet?: string;
  energyBoost?: {
    maxEnergyMultiplier: number;
    regenRateMultiplier: number;
  };
}

export interface NFTServices {
  // Gate NFT operations (for backend/user-facing APIs, not avatar tools)
  getGateStatus: (walletAddress: string) => Promise<GateStatus>;
  getGateCollectionAddress: () => string;

  // Inhabitation operations (for backend/user-facing APIs, not avatar tools)
  getInhabitationInfo: (walletAddress: string) => Promise<InhabitationInfo>;
  listUnclaimedAvatars: () => Promise<UnclaimedAvatar[]>;
  inhabitAvatar: (walletAddress: string, avatarId: string) => Promise<InhabitResult>;
  canAbandon: (walletAddress: string) => Promise<{
    canAbandon: boolean;
    gateStatus: GateStatus;
    inhabitedAvatarId?: string;
    inhabitedAvatarName?: string;
  }>;
  abandonAvatar: (walletAddress: string, burnTxSignature: string) => Promise<AbandonResult>;

  // Burn verification (for backend, not avatar tools)
  verifyGateBurn: (walletAddress: string, signature: string) => Promise<BurnVerification>;

  // Lineage NFT operations (for backend, not avatar tools)
  getLineageCollection: (avatarId: string) => Promise<LineageCollection | null>;
  prepareLineageMint: (avatarId: string, walletAddress: string) => Promise<MintPreparation>;
  recordLineageMint: (
    avatarId: string,
    walletAddress: string,
    nftMint: string,
    era: number,
    burnSignature?: string
  ) => Promise<void>;
  generateLineageMetadata: (metadata: LineageMetadata) => object;

  // Avatar self-awareness (the only thing avatars should access)
  getAvatarInhabitationStatus: (avatarId: string) => Promise<AvatarInhabitationStatus>;
  getInhabitationUrl: (avatarId: string) => string;
  getAvatarAscensionStatus: (avatarId: string) => Promise<AvatarAscensionStatus>;

  // NFT Collection Avatar operations (user-facing, requires wallet context)
  getClaimableNFTs: (walletAddress: string) => Promise<ClaimableNFT[]>;
  claimNFTAsAvatar: (walletAddress: string, mintAddress: string) => Promise<ClaimNFTResult>;
  getWhitelistedCollections: () => string[];
}

// ============================================================================
// Tool Definitions - ONLY avatar self-awareness tools
// ============================================================================

export const createNFTTools = (services: NFTServices) => [
  defineReadonlyTool({
    name: 'get_my_inhabitation_status',
    description:
      'Check if this avatar is currently inhabited by a user. Returns whether someone has claimed this avatar as their avatar, and the current era number.',
    toolset: 'nft',
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      try {
        const status = await services.getAvatarInhabitationStatus(context.avatarId);

        if (status.isInhabited) {
          return {
            success: true,
            data: {
              isInhabited: true,
              message: 'You are currently inhabited by a user.',
              inhabitantWallet: status.inhabitantWallet?.slice(0, 8) + '...', // Partial for privacy
              currentEra: status.currentEra,
              totalEras: status.totalEras,
            },
          };
        }

        return {
          success: true,
          data: {
            isInhabited: false,
            message: 'You are not currently inhabited. Share your inhabitation link for someone to claim you!',
            currentEra: status.currentEra,
            totalEras: status.totalEras,
            inhabitationUrl: services.getInhabitationUrl(context.avatarId),
            action: 'inhabit_avatar',
            avatarId: context.avatarId,
            label: 'Inhabit this avatar',
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get inhabitation status',
        };
      }
    },
  }),

  defineReadonlyTool({
    name: 'get_inhabitation_link',
    description:
      'Get a link that users can click to inhabit this avatar. Share this link when someone wants to claim you as their avatar in shared chats.',
    toolset: 'nft',
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      try {
        const status = await services.getAvatarInhabitationStatus(context.avatarId);
        const url = services.getInhabitationUrl(context.avatarId);

        if (status.isInhabited) {
          return {
            success: true,
            data: {
              url,
              message: 'Note: You are already inhabited. The user would need to wait until your current inhabitant abandons you.',
              isInhabited: true,
              action: 'inhabit_avatar',
              avatarId: context.avatarId,
              label: 'Inhabit this avatar',
            },
          };
        }

        return {
          success: true,
          data: {
            url,
            message: 'Share this link for someone to inhabit you. Inhabitation is free!',
            isInhabited: false,
            action: 'inhabit_avatar',
            avatarId: context.avatarId,
            label: 'Inhabit this avatar',
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get inhabitation link',
        };
      }
    },
  }),

  defineReadonlyTool({
    name: 'get_my_lineage',
    description:
      'Get the lineage history for this avatar - how many eras have passed (times the avatar has been abandoned) and collection info.',
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      try {
        const [status, collection] = await Promise.all([
          services.getAvatarInhabitationStatus(context.avatarId),
          services.getLineageCollection(context.avatarId),
        ]);

        return {
          success: true,
          data: {
            currentEra: status.currentEra,
            totalEras: status.totalEras,
            isInhabited: status.isInhabited,
            hasCollection: !!collection,
            collectionMint: collection?.collectionMint,
            totalLineageNFTsMinted: collection?.totalMinted || 0,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get lineage info',
        };
      }
    },
  }),

  defineReadonlyTool({
    name: 'get_my_ascension_status',
    description:
      'Check if this avatar has been ascended (permanently locked with an Ascension NFT). ' +
      'Ascended avatars have locked personas and profile images, but gain energy bonuses.',
    toolset: 'nft',
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      try {
        const status = await services.getAvatarAscensionStatus(context.avatarId);

        if (status.isAscended) {
          return {
            success: true,
            data: {
              isAscended: true,
              message: 'This avatar has been ascended! Persona and profile image are permanently locked.',
              ascendedAt: status.ascendedAt,
              ascendedNftMint: status.ascendedNftMint,
              energyBoost: status.energyBoost,
              note: 'Only the Ascension NFT holder can inhabit this avatar.',
            },
          };
        }

        return {
          success: true,
          data: {
            isAscended: false,
            message: 'This avatar has not been ascended. The inhabitant can ascend by burning an Orb NFT + RATI tokens.',
            benefits: [
              'Permanently lock persona and profile image',
              'Tradeable avatar identity (NFT holder = owner)',
              '+50% max energy boost',
              '+50% energy regeneration boost',
            ],
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get ascension status',
        };
      }
    },
  }),

  // ==========================================================================
  // NFT Collection Avatar Tools (user-facing)
  // ==========================================================================

  defineReadonlyTool({
    name: 'list_claimable_nfts',
    description:
      'List NFTs from whitelisted collections that the connected wallet owns and can claim as avatars. Returns NFTs that have not yet been claimed by anyone.',
    toolset: 'nft',
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      try {
        // Requires wallet context from sender
        const walletAddress = context.sender?.walletAddress;
        if (!walletAddress) {
          return {
            success: false,
            error: 'No wallet connected. Please connect your wallet to view claimable NFTs.',
          };
        }

        const whitelistedCollections = services.getWhitelistedCollections();
        if (whitelistedCollections.length === 0) {
          return {
            success: true,
            data: {
              message: 'No NFT collections are currently whitelisted for avatar claiming.',
              claimableNFTs: [],
              whitelistedCollections: [],
            },
          };
        }

        const claimableNFTs = await services.getClaimableNFTs(walletAddress);

        if (claimableNFTs.length === 0) {
          return {
            success: true,
            data: {
              message: 'No claimable NFTs found. You may not own any NFTs from the whitelisted collections, or they have already been claimed.',
              claimableNFTs: [],
              whitelistedCollections,
              walletChecked: walletAddress.slice(0, 8) + '...',
            },
          };
        }

        return {
          success: true,
          data: {
            message: `Found ${claimableNFTs.length} NFT(s) that can be claimed as avatars.`,
            claimableNFTs: claimableNFTs.map((nft) => ({
              mint: nft.mint,
              name: nft.name,
              image: nft.image,
              collection: nft.collection,
              collectionName: nft.collectionName,
              description: nft.description,
              personality: nft.personality,
              attributes: nft.attributes,
            })),
            whitelistedCollections,
            instructions: 'Use the claim_nft_as_avatar tool with the NFT mint address to claim one as an avatar.',
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list claimable NFTs',
        };
      }
    },
  }),

  defineReadonlyTool({
    name: 'claim_nft_as_avatar',
    description:
      'Claim an NFT from a whitelisted collection as a new avatar. The NFT image becomes the avatar profile image, and the NFT name becomes the avatar name. Uses your normal avatar creation slots.',
    toolset: 'nft',
    inputSchema: z.object({
      mint: z.string().describe('The Solana mint address of the NFT to claim as an avatar'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        // Requires wallet context from sender
        const walletAddress = context.sender?.walletAddress;
        if (!walletAddress) {
          return {
            success: false,
            error: 'No wallet connected. Please connect your wallet to claim an NFT as an avatar.',
          };
        }

        const result = await services.claimNFTAsAvatar(walletAddress, input.mint);

        if (!result.success) {
          let errorMessage = result.error || 'Failed to claim NFT as avatar';

          // Provide user-friendly error messages
          switch (result.error) {
            case 'no_gate_slot':
              errorMessage = 'You have no available avatar slots. You need to hold an Orb NFT to create more avatars.';
              break;
            case 'nft_already_claimed':
              errorMessage = 'This NFT has already been claimed as an avatar by someone.';
              break;
            case 'nft_not_in_collection':
              errorMessage = 'This NFT is not from a whitelisted collection.';
              break;
            case 'nft_not_owned':
              errorMessage = 'You do not own this NFT.';
              break;
          }

          return {
            success: false,
            error: errorMessage,
          };
        }

        return {
          success: true,
          data: {
            message: `Successfully claimed NFT as avatar "${result.avatarName}"!`,
            avatarId: result.avatarId,
            avatarName: result.avatarName,
            avatarImage: result.avatarImage,
            nftMint: input.mint,
            note: 'This avatar is linked to your NFT. If you sell the NFT, you will lose access to this avatar.',
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to claim NFT as avatar',
        };
      }
    },
  }),
];

export default createNFTTools;
