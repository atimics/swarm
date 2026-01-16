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
];

export default createNFTTools;
