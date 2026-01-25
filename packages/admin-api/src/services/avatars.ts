/**
 * Avatar Management Service
 */
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { DEFAULT_LLM_MODEL, DEFAULT_LLM_PROVIDER, DEFAULT_LLM_TEMPERATURE, DEFAULT_LLM_MAX_TOKENS } from '@swarm/core';
import type { AvatarRecord, UserSession } from '../types.js';
import { syncAvatarConfig } from './config-sync.js';
import {
  getGateStatus,
  incrementCreatorCount,
  decrementCreatorCount,
  isNFTClaimed,
  verifyNFTOwnership,
  isCollectionWhitelisted,
  type GateStatus,
  type ClaimableNFT,
} from './nft-gate.js';
import {
  registerHomeChannel,
  removeAvatarFromAllHomeChannels,
} from './home-channel.js';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

/**
 * Generate a URL-safe avatar ID from name
 */
function generateAvatarId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  
  const suffix = Math.random().toString(36).substring(2, 6);
  return `${base}-${suffix}`;
}

/**
 * Create a new avatar (legacy - uses email session)
 */
export async function createAvatar(
  name: string,
  session: UserSession,
  description?: string
): Promise<AvatarRecord> {
  const avatarId = generateAvatarId(name);
  const now = Date.now();

  const avatar: AvatarRecord = {
    pk: `AVATAR#${avatarId}`,
    sk: 'CONFIG',
    avatarId,
    name,
    description,
    platforms: {},
    voiceConfig: {
      enabled: true,
      ttsProvider: 'voice-clone',
      format: 'ogg',
    },
    llmConfig: {
      provider: DEFAULT_LLM_PROVIDER,
      model: DEFAULT_LLM_MODEL,
      temperature: DEFAULT_LLM_TEMPERATURE,
      maxTokens: DEFAULT_LLM_MAX_TOKENS,
      useGlobalKey: true,
    },
    currentEra: 0,
    status: 'draft',
    createdAt: now,
    createdBy: session.email,
    updatedAt: now,
    updatedBy: session.email,
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: avatar,
    ConditionExpression: 'attribute_not_exists(pk)',
  }));

  // Sync to state table so handlers can access it
  await syncAvatarConfig(avatar);

  return avatar;
}

/**
 * Create avatar result with gate status
 */
export interface CreateAvatarResult {
  success: boolean;
  avatar?: AvatarRecord;
  gateStatus?: GateStatus;
  error?: 'no_gate_slot' | 'invalid_name' | 'name_taken' | 'gate_check_failed';
}

/**
 * Create a new avatar with wallet-based gating
 * Requires the wallet to hold an unused Gate NFT slot
 */
export async function createAvatarWithWallet(
  name: string,
  creatorWallet: string,
  description?: string
): Promise<CreateAvatarResult> {
  // 1. Check gate status (optimistic)
  const gateStatus = await getGateStatus(creatorWallet);
  if (!gateStatus.canCreate) {
    console.log(`[Avatars] No gate slot for wallet=${creatorWallet.slice(0, 8)}... (held=${gateStatus.nftsHeld}, created=${gateStatus.avatarsCreated})`);
    return {
      success: false,
      error: 'no_gate_slot',
      gateStatus,
    };
  }

  const avatarId = generateAvatarId(name);
  const now = Date.now();

  // Determine slot type: first avatar = free, subsequent = orb (NFT-backed)
  const slotType: 'free' | 'orb' = gateStatus.avatarsCreated === 0 ? 'free' : 'orb';

  const avatar: AvatarRecord = {
    pk: `AVATAR#${avatarId}`,
    sk: 'CONFIG',
    avatarId,
    name,
    description,
    platforms: {},
    voiceConfig: {
      enabled: true,
      ttsProvider: 'voice-clone',
      format: 'ogg',
    },
    llmConfig: {
      provider: DEFAULT_LLM_PROVIDER,
      model: DEFAULT_LLM_MODEL,
      temperature: DEFAULT_LLM_TEMPERATURE,
      maxTokens: DEFAULT_LLM_MAX_TOKENS,
      useGlobalKey: true,
    },
    creatorWallet,  // Track who created for slot counting
    slotType,       // Track whether free or orb-backed
    healthStatus: 'healthy',
    currentEra: 0,
    status: 'draft',
    createdAt: now,
    createdBy: creatorWallet,
    updatedAt: now,
    updatedBy: creatorWallet,
  };

  try {
    await dynamoClient.send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: avatar,
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      return { success: false, error: 'name_taken', gateStatus };
    }
    throw err;
  }

  await incrementCreatorCount(creatorWallet);

  // 2. Re-verify gate status (pessimistic check for race conditions)
  // Uses canCreate which properly accounts for free slot: availableSlots = (1 + nftsHeld) - avatarsCreated
  const finalStatus = await getGateStatus(creatorWallet);
  if (!finalStatus.canCreate && finalStatus.availableSlots < 0) {
    // Race condition: user sold NFT between check and create, now over limit
    // Rollback by deleting the avatar
    console.log(`[Avatars] Gate slot race condition for wallet=${creatorWallet.slice(0, 8)}... (created=${finalStatus.avatarsCreated}, slots=${finalStatus.nftsHeld + 1})`);
    await dynamoClient.send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: { ...avatar, status: 'deleted' },
    }));
    await decrementCreatorCount(creatorWallet);
    return {
      success: false,
      error: 'no_gate_slot',
      gateStatus: finalStatus,
    };
  }

  // Sync to state table so handlers can access it
  await syncAvatarConfig(avatar);

  console.log(`[Avatars] Created avatar=${avatarId} by wallet=${creatorWallet.slice(0, 8)}...`);

  return {
    success: true,
    avatar,
    gateStatus: finalStatus,
  };
}

/**
 * List unclaimed avatars (no inhabitant)
 * Only checks inhabitantWallet - ownerWallet is a legacy field
 */
export async function listUnclaimedAvatars(): Promise<AvatarRecord[]> {
  const result = await dynamoClient.send(new ScanCommand({
    TableName: ADMIN_TABLE,
    FilterExpression: 'sk = :sk AND #status <> :deleted AND attribute_not_exists(inhabitantWallet)',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':sk': 'CONFIG',
      ':deleted': 'deleted',
    },
  }));

  return (result.Items as AvatarRecord[]) || [];
}

/**
 * Get an avatar by ID
 */
export async function getAvatar(avatarId: string): Promise<AvatarRecord | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: 'CONFIG',
    },
  }));

  return result.Item as AvatarRecord | null;
}

/**
 * Update an avatar
 */
export async function updateAvatar(
  avatarId: string,
  updates: Partial<Pick<
    AvatarRecord,
    'name'
    | 'description'
    | 'persona'
    | 'platforms'
    | 'llmConfig'
    | 'status'
    | 'profileImage'
    | 'characterReference'
    | 'mediaConfig'
    | 'voiceConfig'
    | 'stickerPack'
  >>,
  session: UserSession
): Promise<AvatarRecord> {
  const existing = await getAvatar(avatarId);
  if (!existing) {
    throw new Error(`Avatar not found: ${avatarId}`);
  }

  // Filter out undefined values to avoid overwriting existing fields
  const cleanUpdates = Object.fromEntries(
    Object.entries(updates).filter(([, v]) => v !== undefined)
  );

  const updated: AvatarRecord = {
    ...existing,
    ...cleanUpdates,
    platforms: updates.platforms
      ? {
          ...existing.platforms,
          ...updates.platforms,
          telegram: updates.platforms.telegram
            ? { ...(existing.platforms.telegram ?? {}), ...updates.platforms.telegram }
            : existing.platforms.telegram,
          twitter: updates.platforms.twitter
            ? { ...(existing.platforms.twitter ?? {}), ...updates.platforms.twitter }
            : existing.platforms.twitter,
          discord: updates.platforms.discord
            ? { ...(existing.platforms.discord ?? {}), ...updates.platforms.discord }
            : existing.platforms.discord,
          web: updates.platforms.web
            ? { ...(existing.platforms.web ?? {}), ...updates.platforms.web }
            : existing.platforms.web,
        }
      : existing.platforms,
    voiceConfig: updates.voiceConfig
      ? { ...(existing.voiceConfig ?? {}), ...updates.voiceConfig }
      : existing.voiceConfig,
    updatedAt: Date.now(),
    updatedBy: session.email,
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: updated,
  }));

  // Sync to state table so handlers can access it
  await syncAvatarConfig(updated);

  // Register home channel if configured
  const telegramConfig = updated.platforms?.telegram;
  if (telegramConfig?.homeChannelId && telegramConfig?.botUsername) {
    try {
      await registerHomeChannel(
        avatarId,
        telegramConfig.homeChannelId,
        telegramConfig.botUsername,
        telegramConfig.homeChannelUsername
      );
    } catch (err) {
      console.warn(`[Avatars] Failed to register home channel for ${avatarId}:`, err);
      // Don't fail the update if home channel registration fails
    }
  }

  // Treat allowedChatIds as global home channels.
  // NOTE: This is intentionally add-only; we do not auto-unregister on config changes
  // to avoid removing channels still used by other avatars.
  if (telegramConfig?.botUsername && telegramConfig?.allowedChatIds && telegramConfig.allowedChatIds.length > 0) {
    const botUsername = telegramConfig.botUsername;
    const results = await Promise.allSettled(
      telegramConfig.allowedChatIds.map((chatId) =>
        registerHomeChannel(avatarId, chatId, botUsername)
      )
    );

    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      console.warn(`[Avatars] Failed to register some allowedChatIds as home channels for ${avatarId} (${failures.length}/${results.length})`);
    }
  }

  return updated;
}

/**
 * List all avatars
 */
export async function listAvatars(): Promise<AvatarRecord[]> {
  // Use a scan with filter for CONFIG records
  // Paginate to handle tables exceeding 1MB scan limit
  const items: AvatarRecord[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await dynamoClient.send(new ScanCommand({
      TableName: ADMIN_TABLE,
      FilterExpression: 'sk = :sk AND #status <> :deleted',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':sk': 'CONFIG',
        ':deleted': 'deleted',
      },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(result.Items as AvatarRecord[]) || []);
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

/**
 * List avatars owned by a specific wallet
 * Returns avatars where:
 * - creatorWallet matches (avatars the wallet created)
 * - OR inhabitantWallet matches (avatars the wallet inhabits)
 * This ensures wallet users see all avatars they have access to
 */
export async function listAvatarsByWallet(walletAddress: string): Promise<AvatarRecord[]> {
  // Paginate to handle tables exceeding 1MB scan limit
  const items: AvatarRecord[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await dynamoClient.send(new ScanCommand({
      TableName: ADMIN_TABLE,
      FilterExpression: 'sk = :sk AND #status <> :deleted AND (creatorWallet = :wallet OR inhabitantWallet = :wallet)',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':sk': 'CONFIG',
        ':deleted': 'deleted',
        ':wallet': walletAddress,
      },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(result.Items as AvatarRecord[]) || []);
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

/**
 * Delete an avatar (soft delete)
 */
export async function deleteAvatar(
  avatarId: string,
  session: UserSession
): Promise<void> {
  const existing = await getAvatar(avatarId);
  if (existing?.creatorWallet && existing.status !== 'deleted') {
    await decrementCreatorCount(existing.creatorWallet);
  }

  // Unregister home channel if configured
  try {
    await removeAvatarFromAllHomeChannels(avatarId);
  } catch (err) {
    console.warn(`[Avatars] Failed to unregister home channel for ${avatarId}:`, err);
    // Don't fail the delete if home channel unregistration fails
  }

  await updateAvatar(avatarId, { status: 'deleted' }, session);
}

/**
 * Configure Telegram for an avatar
 */
export async function configureTelegram(
  avatarId: string,
  botUsername: string,
  session: UserSession
): Promise<AvatarRecord> {
  const existing = await getAvatar(avatarId);
  if (!existing) {
    throw new Error(`Avatar not found: ${avatarId}`);
  }

  return updateAvatar(avatarId, {
    platforms: {
      ...existing.platforms,
      telegram: {
        enabled: true,
        botUsername,
      },
    },
  }, session);
}

/**
 * Configure Twitter for an avatar
 */
export async function configureTwitter(
  avatarId: string,
  username: string,
  session: UserSession
): Promise<AvatarRecord> {
  const existing = await getAvatar(avatarId);
  if (!existing) {
    throw new Error(`Avatar not found: ${avatarId}`);
  }

  return updateAvatar(avatarId, {
    platforms: {
      ...existing.platforms,
      twitter: {
        enabled: true,
        username,
      },
    },
  }, session);
}

/**
 * Configure Discord for an avatar
 */
export async function configureDiscord(
  avatarId: string,
  guildId: string | undefined,
  session: UserSession
): Promise<AvatarRecord> {
  const existing = await getAvatar(avatarId);
  if (!existing) {
    throw new Error(`Avatar not found: ${avatarId}`);
  }

  return updateAvatar(avatarId, {
    platforms: {
      ...existing.platforms,
      discord: {
        enabled: true,
        guildId,
      },
    },
  }, session);
}

/**
 * Reassign avatar ownership (admin-only)
 * Handles slot count adjustments when changing creatorWallet
 */
export async function reassignAvatar(
  avatarId: string,
  updates: {
    creatorWallet?: string;
    inhabitantWallet?: string | null;
  },
  session: UserSession
): Promise<AvatarRecord> {
  const existing = await getAvatar(avatarId);
  if (!existing) {
    throw new Error(`Avatar not found: ${avatarId}`);
  }

  const now = Date.now();
  const oldCreatorWallet = existing.creatorWallet;
  const newCreatorWallet = updates.creatorWallet;

  // Handle slot count adjustments when creatorWallet changes
  if (newCreatorWallet && newCreatorWallet !== oldCreatorWallet) {
    // Decrement old creator's count (frees up their slot)
    if (oldCreatorWallet) {
      await decrementCreatorCount(oldCreatorWallet);
    }
    // Increment new creator's count
    await incrementCreatorCount(newCreatorWallet);
  }

  // Build the update
  const updated: AvatarRecord = {
    ...existing,
    updatedAt: now,
    updatedBy: session.email,
  };

  if (newCreatorWallet !== undefined) {
    updated.creatorWallet = newCreatorWallet;
  }

  // Handle inhabitantWallet: null means clear, undefined means no change
  if (updates.inhabitantWallet === null) {
    updated.inhabitantWallet = undefined;
    updated.inhabitedAt = undefined;
  } else if (updates.inhabitantWallet !== undefined) {
    updated.inhabitantWallet = updates.inhabitantWallet;
    updated.inhabitedAt = now;
  }

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: updated,
  }));

  // Sync to state table
  await syncAvatarConfig(updated);

  return updated;
}

// =============================================================================
// NFT Collection Avatar Support
// =============================================================================

/**
 * Create avatar from NFT result
 */
export interface CreateAvatarFromNFTResult {
  success: boolean;
  avatar?: AvatarRecord;
  gateStatus?: GateStatus;
  error?: 'no_gate_slot' | 'nft_already_claimed' | 'nft_not_in_collection' | 'nft_not_owned';
}

/**
 * Create a new avatar from an NFT in a whitelisted collection
 * Uses the normal slot system (free + Orb NFTs)
 */
export async function createAvatarFromNFT(
  nft: ClaimableNFT,
  creatorWallet: string
): Promise<CreateAvatarFromNFTResult> {
  // 1. Verify collection is whitelisted
  if (!isCollectionWhitelisted(nft.collection)) {
    console.log(`[Avatars] Collection ${nft.collection} is not whitelisted`);
    return {
      success: false,
      error: 'nft_not_in_collection',
    };
  }

  // 2. Verify NFT not already claimed
  if (await isNFTClaimed(nft.mint)) {
    console.log(`[Avatars] NFT ${nft.mint.slice(0, 8)}... already claimed as avatar`);
    return {
      success: false,
      error: 'nft_already_claimed',
    };
  }

  // 3. Verify wallet owns this NFT
  if (!(await verifyNFTOwnership(creatorWallet, nft.mint))) {
    console.log(`[Avatars] Wallet ${creatorWallet.slice(0, 8)}... does not own NFT ${nft.mint.slice(0, 8)}...`);
    return {
      success: false,
      error: 'nft_not_owned',
    };
  }

  // 4. Check gate status (uses normal slot system)
  const gateStatus = await getGateStatus(creatorWallet);
  if (!gateStatus.canCreate) {
    console.log(`[Avatars] No gate slot for wallet=${creatorWallet.slice(0, 8)}...`);
    return {
      success: false,
      error: 'no_gate_slot',
      gateStatus,
    };
  }

  // 5. Generate avatar ID from NFT name
  const avatarId = generateAvatarId(nft.name);
  const now = Date.now();

  // Determine slot type: first avatar = free, subsequent = orb
  const slotType: 'free' | 'orb' = gateStatus.avatarsCreated === 0 ? 'free' : 'orb';

  // Build description from NFT metadata
  const description = nft.description || `Avatar created from NFT: ${nft.name}`;

  // Build persona from NFT personality trait and other attributes
  let persona: string | undefined;
  if (nft.personality) {
    // Use the personality trait as the core persona
    persona = nft.personality;

    // Optionally enrich with other attributes
    if (nft.attributes && nft.attributes.length > 0) {
      const otherTraits = nft.attributes
        .filter((attr) => attr.trait_type?.toLowerCase() !== 'personality')
        .map((attr) => `${attr.trait_type}: ${attr.value}`)
        .join(', ');
      if (otherTraits) {
        persona = `${persona}\n\nTraits: ${otherTraits}`;
      }
    }
  }

  const avatar: AvatarRecord = {
    pk: `AVATAR#${avatarId}`,
    sk: 'CONFIG',
    avatarId,
    name: nft.name,
    description,
    persona,
    platforms: {},
    voiceConfig: {
      enabled: true,
      ttsProvider: 'voice-clone',
      format: 'ogg',
    },
    llmConfig: {
      provider: DEFAULT_LLM_PROVIDER,
      model: DEFAULT_LLM_MODEL,
      temperature: DEFAULT_LLM_TEMPERATURE,
      maxTokens: DEFAULT_LLM_MAX_TOKENS,
      useGlobalKey: true,
    },
    // Set profile image from NFT
    profileImage: nft.image ? {
      url: nft.image,
      s3Key: '', // External URL, not in S3
      updatedAt: now,
    } : undefined,
    // NFT-backing fields
    nftMint: nft.mint,
    nftCollection: nft.collection,
    nftName: nft.name,
    nftImage: nft.image,
    // Ownership tracking
    creatorWallet,
    slotType,
    healthStatus: 'healthy',
    currentEra: 0,
    status: 'draft',
    createdAt: now,
    createdBy: creatorWallet,
    updatedAt: now,
    updatedBy: creatorWallet,
  };

  try {
    await dynamoClient.send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: avatar,
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      // Rare case: avatar ID collision
      return { success: false, error: 'nft_already_claimed', gateStatus };
    }
    throw err;
  }

  await incrementCreatorCount(creatorWallet);

  // Sync to state table
  await syncAvatarConfig(avatar);

  console.log(`[Avatars] Created NFT avatar=${avatarId} from mint=${nft.mint.slice(0, 8)}... by wallet=${creatorWallet.slice(0, 8)}...`);

  return {
    success: true,
    avatar,
    gateStatus: await getGateStatus(creatorWallet),
  };
}

/**
 * Get an avatar with NFT ownership verification
 * For NFT-backed avatars, verifies the wallet still owns the NFT
 * Returns null if the avatar is inaccessible (NFT sold)
 */
export async function getAvatarWithOwnershipCheck(
  avatarId: string,
  walletAddress: string
): Promise<AvatarRecord | null> {
  const avatar = await getAvatar(avatarId);
  if (!avatar) {
    return null;
  }

  // If not NFT-backed, standard access rules apply
  if (!avatar.nftMint) {
    return avatar;
  }

  // For NFT-backed avatars, verify current ownership
  const stillOwns = await verifyNFTOwnership(walletAddress, avatar.nftMint);
  if (!stillOwns) {
    console.log(
      `[Avatars] NFT ownership lost: avatar=${avatarId}, nft=${avatar.nftMint.slice(0, 8)}..., wallet=${walletAddress.slice(0, 8)}...`
    );
    return null; // Avatar inaccessible - NFT was sold
  }

  return avatar;
}

/**
 * Find avatar by NFT mint address
 */
export async function getAvatarByNFTMint(mintAddress: string): Promise<AvatarRecord | null> {
  try {
    const result = await dynamoClient.send(new ScanCommand({
      TableName: ADMIN_TABLE,
      FilterExpression: 'sk = :sk AND nftMint = :mint AND #status <> :deleted',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':sk': 'CONFIG',
        ':mint': mintAddress,
        ':deleted': 'deleted',
      },
      Limit: 1,
    }));

    if (result.Items && result.Items.length > 0) {
      return result.Items[0] as AvatarRecord;
    }
    return null;
  } catch (error) {
    console.error('[Avatars] Error finding avatar by NFT mint:', error);
    return null;
  }
}
