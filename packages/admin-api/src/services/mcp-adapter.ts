/**
 * MCP Service Adapter
 * 
 * Bridges existing admin-api services to MCP server service interfaces.
 * This allows the unified tool definitions to work with our current infrastructure.
 */
import type { AllServices, VoiceServices, NFTServices, PropertyServices } from '@swarm/mcp-server';
import { DEFAULT_LLM_MODEL, DEFAULT_LLM_PROVIDER, DEFAULT_LLM_TEMPERATURE, DEFAULT_LLM_MAX_TOKENS } from '@swarm/core';
import type { UserSession, SecretType } from '../types.js';
import * as avatars from '../services/avatars.js';
import * as secrets from '../services/secrets.js';
import * as wallets from '../services/wallets.js';
import * as telegram from '../services/telegram.js';
import * as twitterOAuth from '../services/twitter-oauth.js';
import * as chatVoting from '../services/chat-voting.js';
import * as discord from '../services/discord.js';
import * as media from '../services/media.js';
import * as gallery from '../services/gallery.js';
import * as credits from '../services/credits.js';
import * as mediaJobs from '../services/media-jobs.js';
import * as voice from '../services/voice.js';
import * as avatarwnership from '../services/avatar-ownership.js';
import * as nftGate from '../services/nft-gate.js';
import * as lineageNft from '../services/lineage-nft.js';
import * as propertyResearch from '../services/property-research.js';
import * as stickers from '../services/stickers.js';
import * as avatarvents from '../services/avatar-events.js';
import * as memory from '../services/memory.js';
import * as memoryMigration from '../services/memory-migration.js';
import { diagnoseTelegram } from '../services/telegram-diagnostics.js';
import { createWebSearch } from '../services/web-search.js';
import { createMcpAdminServices } from '../services/mcp-config.js';
import { setupTelegramIntegration } from '../services/telegram-setup.js';
import { validateReplicateApiKey } from '../services/replicate.js';
import * as integrations from '../services/integrations.js';
import type { IntegrationType, AICapability } from '../services/integrations.js';
import { getModelsForCapability, AVAILABLE_MODELS } from '../services/models-registry.js';

// Timeout for external API calls
const API_TIMEOUT_MS = 10_000;

/**
 * Check if URL is a Replicate delivery URL (which expire quickly)
 */
function isReplicateUrl(url: string): boolean {
  return url.includes('replicate.delivery') || url.includes('replicate.com/v1');
}

/**
 * Detect mime type from URL or response headers
 */
function detectMimeType(url: string, contentType: string | null): string {
  // Use Content-Type header if it's a real image type
  if (contentType && !['application/octet-stream', 'binary/octet-stream'].includes(contentType)) {
    return contentType.split(';')[0];
  }
  
  // Infer from URL extension
  const urlLower = url.toLowerCase();
  if (urlLower.includes('.webp')) return 'image/webp';
  if (urlLower.includes('.jpg') || urlLower.includes('.jpeg')) return 'image/jpeg';
  if (urlLower.includes('.gif')) return 'image/gif';
  return 'image/png';
}

/**
 * Upload media URLs to Twitter and return media IDs
 * If a Replicate URL fails (expired), tries to find the S3 version from gallery
 */
async function uploadMediaToTwitter(
  client: InstanceType<typeof import('twitter-api-v2').TwitterApi>,
  mediaUrls: string[],
  avatarId?: string
): Promise<string[]> {
  const mediaIds: string[] = [];
  
  for (let url of mediaUrls.slice(0, 4)) {
    try {
      console.log('Fetching media from URL:', url);
      let response = await fetch(url);
      
      // If Replicate URL failed (expired), try to find S3 version from gallery
      if (!response.ok && isReplicateUrl(url) && avatarId) {
        console.warn(`Replicate URL expired (${response.status}), searching gallery for S3 URL`);
        try {
          const galleryItems = await gallery.getGallery(avatarId, { type: 'image', limit: 20 });
          // Find most recent image (gallery items are sorted by recency)
          const recentImage = galleryItems[0];
          if (recentImage?.url && !isReplicateUrl(recentImage.url)) {
            console.log('Found S3 URL from gallery:', recentImage.url);
            url = recentImage.url;
            response = await fetch(url);
          }
        } catch (galleryErr) {
          console.error('Failed to search gallery for S3 URL:', galleryErr);
        }
      }
      
      if (!response.ok) {
        console.error('Failed to fetch media:', response.status, response.statusText);
        continue;
      }
      
      const mimeType = detectMimeType(url, response.headers.get('content-type'));
      console.log('Uploading media to Twitter with mimeType:', mimeType);
      
      const buffer = Buffer.from(await response.arrayBuffer());
      console.log('Buffer size:', buffer.length, 'bytes');
      
      const mediaId = await client.v1.uploadMedia(buffer, {
        mimeType: mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
      });
      console.log('Media uploaded successfully, mediaId:', mediaId);
      mediaIds.push(mediaId);
    } catch (err) {
      console.error('Failed to upload media to Twitter:', err);
    }
  }
  
  return mediaIds;
}

/**
 * Get bot token from secrets for a given avatar
 */
async function getBotToken(avatarId: string): Promise<string> {
  const botToken = await secrets._getSecretValueInternal(avatarId, 'telegram_bot_token', 'default');
  if (!botToken) {
    throw new Error('No Telegram bot token configured');
  }
  return botToken;
}

/**
 * Fetch with timeout using AbortController
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Create MCP-compatible services for a specific avatar
 */
export function createMCPServices(_avatarId: string, session: UserSession): AllServices {
  const avatarId = _avatarId;
  // Voice tools enabled by default; set ENABLE_VOICE_TOOLS=false to disable
  const voiceEnabled = process.env.ENABLE_VOICE_TOOLS !== 'false';
  const voiceServices: VoiceServices | undefined = voiceEnabled ? {
    transcribeAudio: async (params: Parameters<VoiceServices['transcribeAudio']>[0]) => {
      let audioUrl = params.url;
      if (!audioUrl && params.platformFileId) {
        const botToken = await getBotToken(avatarId);
        audioUrl = await telegram.getFileUrl(botToken, params.platformFileId);
      }
      return voice.transcribeAudio({
        avatarId,
        assetId: params.assetId,
        url: audioUrl,
        language: params.language,
        model: params.model,
        diarize: params.diarize,
      });
    },
    createMyVoice: async (params: Parameters<VoiceServices['createMyVoice']>[0]) => {
      return voice.createMyVoice({
        avatarId: params.avatarId,
        description: params.description,
        updatedBy: session.email,
      });
    },
    hasVoice: async (avatardParam: string) => {
      return voice.hasVoice(avatardParam);
    },
    sendVoiceMessage: async (params: Parameters<VoiceServices['sendVoiceMessage']>[0]) => {
      return voice.sendVoiceMessage({
        avatarId,
        platform: params.platform,
        text: params.text,
        conversationId: params.conversationId,
        voiceId: params.voiceId,
        format: params.format,
        speed: params.speed,
        replyToMessageId: params.replyToMessageId,
      });
    },
  } : undefined;

  return {
    // =========================================================================
    // Media Services
    // =========================================================================
    media: {
      generateImage: async (params) => {
        // Use async generation to avoid API Gateway timeout (29s limit)
        // The image will be delivered via webhook callback
        const job = await media.generateImageAsync({
          prompt: params.prompt,
          avatarId: params.avatarId,
          platform: params.platform,
          referenceImageUrls: params.referenceImageUrls,
          resolution: params.resolution as '1K' | '2K' | '4K' | undefined,
          aspectRatio: params.aspectRatio as '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9' | '21:9' | undefined,
          conversationId: params.conversationId || `admin-ui-${Date.now()}`,
          replyToMessageId: params.replyToMessageId,
        });
        return { jobId: job.jobId, status: job.status };
      },

      generateVideo: async (params) => {
        const result = await media.generateVideo({
          prompt: params.prompt,
          avatarId: params.avatarId,
          platform: params.platform,
          referenceImageUrl: params.referenceImageUrl,
          conversationId: params.conversationId || `mcp-${Date.now()}`,
          replyToMessageId: params.replyToMessageId,
        });
        return { jobId: result.jobId, status: result.status };
      },

      generateSticker: async (params) => {
        const result = await media.generateSticker({
          prompt: params.prompt || 'sticker',
          avatarId: params.avatarId,
          sourceImageId: params.sourceImageId,
        });
        return { id: result.id, url: result.url };
      },

      getProfileImageUrl: async (avatarId) => {
        const avatar = await avatars.getAvatar(avatarId);
        return avatar?.profileImage?.url;
      },

      getReferenceImageUrl: async (avatarId, category) => {
        const images = await media.listReferenceImages(avatarId);
        const found = images.find(img => img.category === category);
        return found?.url;
      },

      getCharacterReferenceUrl: async (avatarId) => {
        const avatar = await avatars.getAvatar(avatarId);
        return avatar?.characterReference?.url;
      },

      getBestReferenceImageUrl: async (avatarId) => {
        return media.getBestReferenceImageUrl(avatarId);
      },
    },

    // =========================================================================
    // Media Credits
    // =========================================================================
    mediaCredits: {
      canUseTool: async (avatarId, tool) => {
        const result = await credits.canUseTool(avatarId, tool);
        return { allowed: result.allowed, reason: result.reason };
      },
      consumeCredit: async (avatarId, tool) => {
        return credits.consumeCredit(avatarId, tool);
      },
    },

    // =========================================================================
    // Job Credits (same as media credits for now)
    // =========================================================================
    jobCredits: {
      getToolStatus: async (avatarId) => {
        // Return structured credit data
        const status = await credits.getToolStatusStructured(avatarId);
        return status;
      },
      getEnergyStatus: async (avatarId) => {
        return credits.getEnergyStatus(avatarId);
      },
    },

    // =========================================================================
    // Gallery Services
    // =========================================================================
    gallery: {
      getGallery: async (avatarId, options) => {
        const items = await gallery.getGallery(avatarId, {
          type: options.type,
          limit: options.limit,
        });
        return items.map(item => ({
          id: item.id,
          type: item.type as 'image' | 'video' | 'sticker',
          url: item.url,
          prompt: item.prompt,
          createdAt: item.createdAt,
        }));
      },

      getGalleryItem: async (avatarId, itemId) => {
        const item = await gallery.getGalleryItem(avatarId, itemId);
        if (!item) return null;
        return {
          id: item.id,
          type: item.type as 'image' | 'video' | 'sticker',
          url: item.url,
          prompt: item.prompt,
          createdAt: item.createdAt,
        };
      },

      searchGallery: async (avatarId, query, type) => {
        const items = await gallery.findByDescription(avatarId, query, type);
        return items.map(item => ({
          id: item.id,
          type: item.type as 'image' | 'video' | 'sticker',
          url: item.url,
          prompt: item.prompt,
          createdAt: item.createdAt,
        }));
      },
    },

    // =========================================================================
    // Wallet Services
    // =========================================================================
    wallets: {
      listWallets: async (avatarId) => {
        const walletList = await wallets.listWallets(avatarId);
        return Promise.all(
          walletList.map(async (w) => {
            try {
              const balance = w.walletType === 'ethereum'
                ? await wallets.getEthereumBalance(w.address, avatarId)
                : await wallets.getSolanaBalance(w.publicKey, avatarId);
              
              return {
                name: w.name,
                publicKey: w.publicKey,
                address: w.address,
                walletType: w.walletType,
                balance: balance.balance,
                solBalance: w.walletType === 'solana' ? balance.balance : null,
                ethBalance: w.walletType === 'ethereum' ? balance.balance : null,
              };
            } catch {
              return {
                name: w.name,
                publicKey: w.publicKey,
                address: w.address,
                walletType: w.walletType,
                balance: 0,
                solBalance: 0,
                ethBalance: 0,
              };
            }
          })
        );
      },

      createWallet: async (avatarId, name, chain = 'solana') => {
        const result = chain === 'ethereum'
          ? await wallets.generateEthereumWallet(avatarId, name, session)
          : await wallets.generateSolanaWallet(avatarId, name, session);
        return { 
          publicKey: result.publicKey, 
          address: result.address,
          walletType: result.walletType
        };
      },

      createVanityWallet: async (avatarId, name, pattern, matchStart) => {
        const result = await wallets.generateAndSaveVanityWallet(
          avatarId, 
          name, 
          pattern, 
          matchStart, 
          session
        );
        return {
          publicKey: result.publicKey,
          address: result.address,
          walletType: result.walletType,
          attempts: result.attempts,
          elapsedMs: result.elapsedMs,
        };
      },

      getBalance: async (publicKey, avatarId, chain = 'solana') => {
        const balance = chain === 'ethereum'
          ? await wallets.getEthereumBalance(publicKey, avatarId)
          : await wallets.getSolanaBalance(publicKey, avatarId);
        return {
          balance: balance.balance,
          chain: balance.chain,
          solBalance: balance.chain === 'solana' ? balance.balance : undefined,
          solBalanceLamports: balance.solBalanceLamports,
          ethBalance: balance.chain === 'ethereum' ? balance.balance : undefined,
          ethBalanceWei: balance.ethBalanceWei,
          tokens: balance.tokens || [],
        };
      },
    },

    // =========================================================================
    // Model Services
    // =========================================================================
    models: {
      listModels: async (family) => {
        const response = await fetchWithTimeout(
          'https://openrouter.ai/api/v1/models',
          { headers: { 'Content-Type': 'application/json' } },
          API_TIMEOUT_MS
        );

        if (!response.ok) return [];

        const data = await response.json() as {
          data: Array<{
            id: string;
            name: string;
            context_length: number;
            pricing?: { prompt: string; completion: string };
            architecture?: { modality?: string };
          }>;
        };

        let models = data.data || [];

        // Filter to text-capable models (keep entries with missing modality)
        models = models.filter(m => {
          const modality = m.architecture?.modality;
          if (!modality) return true;
          return modality.includes('text');
        });

        if (family) {
          const f = family.toLowerCase();
          models = models.filter(m => m.id.toLowerCase().startsWith(f + '/') || m.id.toLowerCase().includes('/' + f));
        }

        // Sort by provider, then by name
        models.sort((a, b) => {
          const providerA = a.id.split('/')[0] || '';
          const providerB = b.id.split('/')[0] || '';
          if (providerA !== providerB) return providerA.localeCompare(providerB);
          return a.name.localeCompare(b.name);
        });

        // Return all models (UI will handle display)
        return models.map(m => ({
          id: m.id,
          name: m.name,
          provider: m.id.split('/')[0] || 'other',
          contextLength: m.context_length,
          pricing: m.pricing ? {
            prompt: parseFloat(m.pricing.prompt),
            completion: parseFloat(m.pricing.completion),
          } : undefined,
        }));
      },

      getConfig: async (avatarId) => {
        const avatar = await avatars.getAvatar(avatarId);
        if (!avatar) {
          return { model: DEFAULT_LLM_MODEL, temperature: DEFAULT_LLM_TEMPERATURE, maxTokens: DEFAULT_LLM_MAX_TOKENS };
        }
        return {
          model: avatar.llmConfig?.model || DEFAULT_LLM_MODEL,
          temperature: avatar.llmConfig?.temperature ?? DEFAULT_LLM_TEMPERATURE,
          maxTokens: avatar.llmConfig?.maxTokens || DEFAULT_LLM_MAX_TOKENS,
        };
      },

      updateConfig: async (avatarId, config) => {
        const avatar = await avatars.getAvatar(avatarId);
        const currentConfig = avatar?.llmConfig || {
          provider: DEFAULT_LLM_PROVIDER,
          model: DEFAULT_LLM_MODEL,
          temperature: DEFAULT_LLM_TEMPERATURE,
          maxTokens: DEFAULT_LLM_MAX_TOKENS,
          useGlobalKey: true,
        };
        const newLlmConfig = {
          ...currentConfig,
          ...config,
        };
        await avatars.updateAvatar(avatarId, { llmConfig: newLlmConfig } as Record<string, unknown>, session);
      },
    },

    // =========================================================================
    // Profile Services
    // =========================================================================
    profile: {
      getProfile: async (avatarId) => {
        const avatar = await avatars.getAvatar(avatarId);
        if (!avatar) {
          return { name: 'Unknown' };
        }
        return {
          name: avatar.name || 'Unnamed',
          description: avatar.description,
          persona: avatar.persona,
          profileImage: avatar.profileImage ? { url: avatar.profileImage.url } : undefined,
          characterReference: avatar.characterReference ? { 
            url: avatar.characterReference.url, 
            description: avatar.characterReference.description 
          } : undefined,
        };
      },

      updateProfile: async (avatarId, updates) => {
        await avatars.updateAvatar(avatarId, updates, session);
      },

      setProfileImage: async (avatarId, source) => {
        if (source.type === 'generate') {
          if (!source.prompt) {
            throw new Error('Prompt is required to generate a profile image.');
          }
          const job = await media.generateProfileImageAsync(avatarId, source.prompt);
          return { jobId: job.jobId, status: job.status };
        }

        const result = await media.setProfileImage(avatarId, source);
        await avatars.updateAvatar(avatarId, {
          profileImage: { url: result.url, s3Key: result.s3Key, updatedAt: Date.now() }
        }, session);
        return { url: result.url };
      },

      getProfileUploadUrl: async (avatarId) => {
        return media.getProfileImageUploadUrl(avatarId);
      },

      saveProfileImage: async (avatarId, s3Key, publicUrl) => {
        await avatars.updateAvatar(avatarId, {
          profileImage: { url: publicUrl, s3Key, updatedAt: Date.now() }
        }, session);
      },

      // Character reference (full-body) for image/video generation
      setCharacterReference: async (avatarId, source, description) => {
        // For now, we handle url and gallery directly; generate would need async job
        if (source.type === 'generate') {
          // Character sheet generation - uses wider aspect ratio
          const result = await media.setCharacterReference(avatarId, source, description);
          return { url: result.url };
        }

        const result = await media.setCharacterReference(avatarId, source, description);
        return { url: result.url };
      },

      getCharacterReferenceUploadUrl: async (avatarId) => {
        return media.getCharacterReferenceUploadUrl(avatarId);
      },

      saveCharacterReference: async (avatarId, s3Key, publicUrl, description) => {
        await avatars.updateAvatar(avatarId, {
          characterReference: { url: publicUrl, s3Key, description, updatedAt: Date.now() }
        }, session);
      },
    },

    // =========================================================================
    // Secret Services
    // =========================================================================
    secrets: {
      listSecrets: async (avatarId) => {
        const secretList = await secrets.listSecrets(avatarId);
        return secretList.map(s => ({
          secretType: s.secretType as SecretType,
          name: s.name,
          description: s.description,
          lastUpdated: s.createdAt,
        }));
      },

      storeSecret: async (avatarId, secretType, name, value, description) => {
        if (secretType === 'telegram_bot_token') {
          console.log(JSON.stringify({
            level: 'INFO',
            subsystem: 'telegram',
            event: 'telegram_token_setup_requested',
            avatarId,
            message: 'Telegram bot token received, validating and registering webhook...',
          }));

          const setupResult = await setupTelegramIntegration({
            avatarId,
            token: value,
            session,
            deps: {
              validateTelegramToken: telegram.validateTelegramToken,
              registerTelegramWebhook: telegram.registerTelegramWebhook,
              generateWebhookSecret: telegram.generateWebhookSecret,
              updateAvatar: avatars.updateAvatar,
              storeSecret: secrets.storeSecret,
            },
          });

          if (!setupResult.success) {
            console.log(JSON.stringify({
              level: 'ERROR',
              subsystem: 'telegram',
              event: 'telegram_token_setup_failed',
              avatarId,
              error: setupResult.error,
            }));
            throw new Error(setupResult.error || 'Failed to configure Telegram');
          }

          return;
        }

        if (secretType === 'replicate_api_key') {
          console.log(JSON.stringify({
            level: 'INFO',
            subsystem: 'media',
            event: 'replicate_key_validation_requested',
            avatarId,
            message: 'Replicate API key received, validating...',
          }));

          const validation = await validateReplicateApiKey(value);
          if (!validation.valid) {
            throw new Error(validation.error || 'Replicate API key invalid');
          }
        }

        await secrets.storeSecret(avatarId, secretType as SecretType, name, value, session, description);
      },

      validateTelegramToken: telegram.validateTelegramToken,
    },

    // =========================================================================
    // Job Services
    // =========================================================================
    jobs: {
      getPendingJobs: async (avatarId) => {
        let pendingJobs = await mediaJobs.getPendingJobs(avatarId);

        // Poll Replicate for processing jobs
        if (pendingJobs.length > 0) {
          const replicateKey = await media.getProviderApiKey(avatarId, 'replicate');
          if (replicateKey) {
            for (const job of pendingJobs) {
              if ((job.status === 'processing' || job.status === 'pending') && job.externalId) {
                await mediaJobs.pollAndCompleteJob(job.jobId, replicateKey);
              }
            }
            pendingJobs = await mediaJobs.getPendingJobs(avatarId);
          }
        }

        return pendingJobs.map(job => ({
          jobId: job.jobId,
          type: job.type as 'image' | 'video' | 'sticker',
          status: job.status as 'pending' | 'processing' | 'completed' | 'failed',
          prompt: job.prompt,
          resultUrl: job.resultUrl,
          createdAt: job.createdAt,
          completedAt: job.completedAt,
        }));
      },

      getJob: async (avatarId, jobId) => {
        let job = await mediaJobs.getJob(jobId);
        if (!job) return null;

        // Verify job belongs to this avatar
        if (job.avatarId !== avatarId) {
          return null;
        }

        // Poll if still processing
        if ((job.status === 'processing' || job.status === 'pending') && job.externalId) {
          const replicateKey = await media.getProviderApiKey(job.avatarId, 'replicate');
          if (replicateKey) {
            const polledJob = await mediaJobs.pollAndCompleteJob(job.jobId, replicateKey);
            if (polledJob) job = polledJob;
          }
        }

        return {
          jobId: job.jobId,
          type: job.type as 'image' | 'video' | 'sticker',
          status: job.status as 'pending' | 'processing' | 'completed' | 'failed',
          prompt: job.prompt,
          resultUrl: job.resultUrl,
          error: job.error,
          createdAt: job.createdAt,
          completedAt: job.completedAt,
        };
      },
    },

    // =========================================================================
    // Reference Image Services
    // =========================================================================
    reference: {
      getUploadUrl: async (avatarId, category, name, _description) => {
        return media.getReferenceImageUploadUrl(avatarId, category, name);
      },

      saveReferenceImage: async (avatarId, data) => {
        const result = await media.saveReferenceImage(
          avatarId,
          data.category,
          data.s3Key,
          data.publicUrl,
          data.name,
          data.description
        );
        return { id: result.id };
      },

      listReferenceImages: async (avatarId, category) => {
        const images = await media.listReferenceImages(avatarId, category);
        return images.map(img => ({
          id: img.id,
          category: img.category as 'profile' | 'character' | 'style' | 'background' | 'other',
          name: img.name,
          url: img.url,
          description: img.description,
          createdAt: img.createdAt || Date.now(),
        }));
      },

      deleteReferenceImage: async (avatarId, imageId) => {
        await media.deleteReferenceImage(avatarId, imageId);
      },
    },

    // =========================================================================
    // Voice Services (optional)
    // =========================================================================
    voice: voiceServices,

    // =========================================================================
    // Memory Services
    // =========================================================================
    memory: {
      remember: async (fact: string, about?: string, userId?: string) => {
        const result = await memory.remember(avatarId, fact, about, userId);
        return { saved: result.saved };
      },

      recall: async (query: string, userId?: string) => {
        const result = await memory.recall(avatarId, query, userId);
        return {
          facts: result.facts.map(f => ({
            fact: f.fact,
            about: f.about,
            userId,
            timestamp: f.timestamp,
            strength: f.strength,
          })),
        };
      },

      getEmbeddingStats: async () => {
        return memoryMigration.getEmbeddingStats(avatarId);
      },

      backfillEmbeddings: async (options?: { dryRun?: boolean }) => {
        return memoryMigration.backfillEmbeddings(avatarId, {
          dryRun: options?.dryRun,
        });
      },
    },

    // =========================================================================
    // Telegram Services
    // =========================================================================
    telegram: {
      diagnoseTelegram: async (avatarId: string) => {
        return diagnoseTelegram(avatarId);
      },

      getUserProfilePhotos: async (avatarId, userId, options) => {
        const botToken = await getBotToken(avatarId);
        
        const result = await telegram.getUserProfilePhotos(botToken, userId, options);
        
        // Get file URLs for photos
        const photos = [];
        for (const photoSizes of result.photos) {
          // Get the largest size
          const largest = photoSizes.reduce((a, b) => 
            (a.width * a.height > b.width * b.height) ? a : b
          );
          
          let fileUrl: string | undefined;
          try {
            fileUrl = await telegram.getFileUrl(botToken, largest.file_id);
          } catch {
            // File URL fetch failed, skip
          }
          
          photos.push({
            fileId: largest.file_id,
            width: largest.width,
            height: largest.height,
            fileUrl,
          });
        }
        
        return {
          userId,
          totalPhotos: result.totalCount,
          photos,
        };
      },

      getBotName: async (avatarId) => {
        const botToken = await getBotToken(avatarId);
        return telegram.getBotName(botToken);
      },

      setBotName: async (avatarId, name, languageCode) => {
        const botToken = await getBotToken(avatarId);
        await telegram.setBotName(botToken, name, languageCode);
      },

      getBotDescription: async (avatarId) => {
        const botToken = await getBotToken(avatarId);
        return telegram.getBotDescription(botToken);
      },

      setBotDescription: async (avatarId, description, languageCode) => {
        const botToken = await getBotToken(avatarId);
        await telegram.setBotDescription(botToken, description, languageCode);
      },

      getBotShortDescription: async (avatarId) => {
        const botToken = await getBotToken(avatarId);
        return telegram.getBotShortDescription(botToken);
      },

      setBotShortDescription: async (avatarId, shortDescription, languageCode) => {
        const botToken = await getBotToken(avatarId);
        await telegram.setBotShortDescription(botToken, shortDescription, languageCode);
      },

      sendChatAction: async (avatarId, chatId, action) => {
        const botToken = await getBotToken(avatarId);
        await telegram.sendChatAction(botToken, chatId, action);
      },

      replyToMessage: async (avatarId, chatId, replyToMessageId, text) => {
        const botToken = await getBotToken(avatarId);
        return telegram.sendMessage(botToken, chatId, text, { replyToMessageId });
      },

      reactToMessage: async (avatarId, chatId, messageId, emoji) => {
        const botToken = await getBotToken(avatarId);
        await telegram.setMessageReaction(botToken, chatId, messageId, emoji);
      },

      // Chat Modification Voting System
      getChatBots: async (chatId) => {
        return chatVoting.getChatBots(chatId);
      },

      proposeModification: async (avatarId, chatId, type, newValue, reason) => {
        const proposal = await chatVoting.createProposal(avatarId, chatId, type, newValue, reason);
        const withCounts = chatVoting.computeProposalCounts(proposal);
        return withCounts;
      },

      voteOnProposal: async (avatarId, proposalId, vote, comment) => {
        const proposal = await chatVoting.voteOnProposal(avatarId, proposalId, vote, comment);
        return chatVoting.computeProposalCounts(proposal);
      },

      getActiveProposals: async (chatId) => {
        const proposals = await chatVoting.getActiveProposals(chatId);
        return proposals.map(p => chatVoting.computeProposalCounts(p));
      },

      getProposal: async (proposalId) => {
        const proposal = await chatVoting.getProposal(proposalId);
        if (!proposal) return null;
        return chatVoting.computeProposalCounts(proposal);
      },

      canModifyChat: async (chatId, type) => {
        return chatVoting.canModifyChat(chatId, type);
      },

      executeModification: async (avatarId, proposalId) => {
        const botToken = await getBotToken(avatarId);
        return chatVoting.executeModification(avatarId, proposalId, botToken);
      },
    },

    // =========================================================================
    // Twitter Services
    // =========================================================================
    twitter: {
      getConnectionStatus: async () => {
        return twitterOAuth.getConnectionStatus(_avatarId);
      },

      startOAuthFlow: async () => {
        try {
          const result = await twitterOAuth.startOAuthFlow(_avatarId);
          return { authorizationUrl: result.authorizationUrl };
        } catch (error) {
          console.error('Failed to start Twitter OAuth flow:', error);
          return null;
        }
      },

      postTweet: async (text: string, mediaUrls?: string[], galleryIds?: string[]): Promise<{ tweetId: string; url: string } | { error: string } | null> => {
        // Get credentials
        const creds = await twitterOAuth.getAvatarTwitterCredentials(_avatarId);
        if (!creds.configured) {
          console.error(JSON.stringify({
            level: 'ERROR',
            subsystem: 'twitter',
            event: 'twitter_post_no_credentials',
            avatarId: _avatarId,
            message: 'Twitter credentials not configured',
          }));
          return { error: 'Twitter is not configured. Please connect Twitter first.' };
        }

        // Security: Require a verified connection record (userId) and ensure the access tokens
        // belong to that exact user before posting. This prevents posting from an unintended
        // account if stale/wrong tokens are present.
        const expectedConnection = await twitterOAuth.getConnectionStatus(_avatarId);
        if (!expectedConnection.connected || !expectedConnection.userId) {
          console.error(JSON.stringify({
            level: 'ERROR',
            subsystem: 'twitter',
            event: 'twitter_connection_unverified',
            avatarId: _avatarId,
            connected: expectedConnection.connected,
            message: 'Twitter connection is not verified (missing userId). Reconnect required before posting.',
          }));
          return { error: 'Twitter connection is not verified. Please reconnect your Twitter account.' };
        }

        // Resolve gallery IDs to URLs (preferred over raw URLs)
        let resolvedMediaUrls: string[] = [];
        
        if (galleryIds && galleryIds.length > 0) {
          console.log('Resolving gallery IDs to URLs:', galleryIds);
          for (const galleryId of galleryIds.slice(0, 4)) {
            try {
              const item = await gallery.getGalleryItem(_avatarId, galleryId);
              if (item?.url) {
                console.log(`Gallery item ${galleryId} resolved to: ${item.url}`);
                resolvedMediaUrls.push(item.url);
              } else {
                console.warn(`Gallery item ${galleryId} not found`);
              }
            } catch (err) {
              console.error(`Failed to resolve gallery item ${galleryId}:`, err);
            }
          }
        }
        
        // Fall back to raw URLs if no gallery IDs or resolution failed
        if (resolvedMediaUrls.length === 0 && mediaUrls && mediaUrls.length > 0) {
          console.log('Using raw media URLs (gallery IDs not provided or failed)');
          resolvedMediaUrls = mediaUrls;
        }

        // Import twitter-api-v2 dynamically to avoid loading it when not needed
        const { TwitterApi } = await import('twitter-api-v2');
        
        const client = new TwitterApi({
          appKey: creds.appKey!,
          appSecret: creds.appSecret!,
          accessToken: creds.accessToken!,
          accessSecret: creds.accessSecret!,
        });

        try {
          // Skip v2.me() identity verification - it's rate-limited and we already verified
          // the connection status above. The stored userId came from OAuth and the tokens
          // are tied to that account by Twitter's OAuth flow.
          const username = expectedConnection.username;

          // Handle media uploads if provided
          const twitterMediaIds = resolvedMediaUrls.length > 0 
            ? await uploadMediaToTwitter(client, resolvedMediaUrls, _avatarId)
            : undefined;

          // Post the tweet
          const tweetParams: Parameters<typeof client.v2.tweet>[0] = { text };
          if (twitterMediaIds && twitterMediaIds.length > 0) {
            tweetParams.media = { media_ids: twitterMediaIds as [string] };
          }

          const result = await client.v2.tweet(tweetParams);
          const tweetId = result.data.id;
          console.log(JSON.stringify({
            level: 'INFO',
            subsystem: 'twitter',
            event: 'twitter_post_success',
            avatarId: _avatarId,
            tweetId,
            username,
            textLength: text.length,
          }));
          return {
            tweetId,
            url: `https://x.com/${username}/status/${tweetId}`,
          };
        } catch (error) {
          // Extract useful error details from Twitter API error
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          const errorData = (error as { data?: { detail?: string; title?: string } })?.data;
          const twitterError = errorData?.detail || errorData?.title || errorMessage;

          console.error(JSON.stringify({
            level: 'ERROR',
            subsystem: 'twitter',
            event: 'twitter_post_failed',
            avatarId: _avatarId,
            error: twitterError,
            errorRaw: errorMessage,
            textLength: text.length,
          }));
          return { error: `Failed to post tweet: ${twitterError}` };
        }
      },

      // Extended Twitter methods
      getTimeline: async (count = 20) => {
        const creds = await twitterOAuth.getAvatarTwitterCredentials(_avatarId);
        if (!creds.configured) return [];

        const { TwitterApi } = await import('twitter-api-v2');
        const client = new TwitterApi({
          appKey: creds.appKey!,
          appSecret: creds.appSecret!,
          accessToken: creds.accessToken!,
          accessSecret: creds.accessSecret!,
        });

        try {
          const me = await client.v2.me();
          const timeline = await client.v2.userTimeline(me.data.id, {
            max_results: Math.min(count, 100),
            expansions: ['author_id'],
            'tweet.fields': ['created_at', 'public_metrics', 'conversation_id'],
            'user.fields': ['username', 'name'],
          });

          return (timeline.data.data || []).map(t => {
            const author = timeline.includes?.users?.find(u => u.id === t.author_id);
            return {
              id: t.id,
              text: t.text,
              authorId: t.author_id || '',
              authorUsername: author?.username,
              authorName: author?.name,
              createdAt: t.created_at || new Date().toISOString(),
              conversationId: t.conversation_id,
              metrics: t.public_metrics ? {
                replyCount: t.public_metrics.reply_count,
                retweetCount: t.public_metrics.retweet_count,
                likeCount: t.public_metrics.like_count,
                quoteCount: t.public_metrics.quote_count,
              } : undefined,
            };
          });
        } catch (error) {
          console.error('Failed to get Twitter timeline:', error);
          return [];
        }
      },

      getMentions: async (sinceId?: string, count = 20) => {
        const creds = await twitterOAuth.getAvatarTwitterCredentials(_avatarId);
        if (!creds.configured) return [];

        const { TwitterApi } = await import('twitter-api-v2');
        const client = new TwitterApi({
          appKey: creds.appKey!,
          appSecret: creds.appSecret!,
          accessToken: creds.accessToken!,
          accessSecret: creds.accessSecret!,
        });

        try {
          const me = await client.v2.me();
          const mentions = await client.v2.userMentionTimeline(me.data.id, {
            since_id: sinceId,
            max_results: Math.min(count, 100),
            expansions: ['author_id'],
            'tweet.fields': ['created_at', 'conversation_id', 'in_reply_to_user_id'],
            'user.fields': ['username', 'name'],
          });

          return (mentions.data.data || []).map(t => {
            const author = mentions.includes?.users?.find(u => u.id === t.author_id);
            return {
              id: t.id,
              text: t.text,
              authorId: t.author_id || '',
              authorUsername: author?.username,
              authorName: author?.name,
              createdAt: t.created_at || new Date().toISOString(),
              conversationId: t.conversation_id,
              inReplyToUserId: t.in_reply_to_user_id,
            };
          });
        } catch (error) {
          console.error('Failed to get Twitter mentions:', error);
          return [];
        }
      },

      getTweet: async (tweetId: string) => {
        const creds = await twitterOAuth.getAvatarTwitterCredentials(_avatarId);
        if (!creds.configured) return null;

        const { TwitterApi } = await import('twitter-api-v2');
        const client = new TwitterApi({
          appKey: creds.appKey!,
          appSecret: creds.appSecret!,
          accessToken: creds.accessToken!,
          accessSecret: creds.accessSecret!,
        });

        try {
          const tweet = await client.v2.singleTweet(tweetId, {
            expansions: ['author_id', 'referenced_tweets.id'],
            'tweet.fields': ['created_at', 'public_metrics', 'conversation_id'],
            'user.fields': ['username', 'name'],
          });

          const author = tweet.includes?.users?.find(u => u.id === tweet.data.author_id);
          return {
            id: tweet.data.id,
            text: tweet.data.text,
            authorId: tweet.data.author_id || '',
            authorUsername: author?.username,
            authorName: author?.name,
            createdAt: tweet.data.created_at || new Date().toISOString(),
            conversationId: tweet.data.conversation_id,
            metrics: tweet.data.public_metrics ? {
              replyCount: tweet.data.public_metrics.reply_count,
              retweetCount: tweet.data.public_metrics.retweet_count,
              likeCount: tweet.data.public_metrics.like_count,
              quoteCount: tweet.data.public_metrics.quote_count,
            } : undefined,
            referencedTweets: tweet.data.referenced_tweets?.map(r => ({
              type: r.type as 'replied_to' | 'quoted' | 'retweeted',
              id: r.id,
            })),
          };
        } catch (error) {
          console.error('Failed to get tweet:', error);
          return null;
        }
      },

      reply: async (tweetId: string, text: string, mediaUrls?: string[], galleryIds?: string[]) => {
        const creds = await twitterOAuth.getAvatarTwitterCredentials(_avatarId);
        if (!creds.configured) return null;

        // Resolve gallery IDs to URLs (preferred over raw URLs)
        let resolvedMediaUrls: string[] = [];
        
        if (galleryIds && galleryIds.length > 0) {
          console.log('Reply: Resolving gallery IDs to URLs:', galleryIds);
          for (const galleryId of galleryIds.slice(0, 4)) {
            try {
              const item = await gallery.getGalleryItem(_avatarId, galleryId);
              if (item?.url) {
                resolvedMediaUrls.push(item.url);
              }
            } catch (err) {
              console.error(`Failed to resolve gallery item ${galleryId}:`, err);
            }
          }
        }
        
        if (resolvedMediaUrls.length === 0 && mediaUrls && mediaUrls.length > 0) {
          resolvedMediaUrls = mediaUrls;
        }

        const { TwitterApi } = await import('twitter-api-v2');
        const client = new TwitterApi({
          appKey: creds.appKey!,
          appSecret: creds.appSecret!,
          accessToken: creds.accessToken!,
          accessSecret: creds.accessSecret!,
        });

        try {
          // Get authenticated user for URL construction
          const me = await client.v2.me();

          const twitterMediaIds = resolvedMediaUrls.length > 0
            ? await uploadMediaToTwitter(client, resolvedMediaUrls, _avatarId)
            : undefined;

          const tweetParams: Parameters<typeof client.v2.tweet>[0] = {
            text,
            reply: { in_reply_to_tweet_id: tweetId },
          };
          if (twitterMediaIds && twitterMediaIds.length > 0) {
            tweetParams.media = { media_ids: twitterMediaIds as [string] };
          }

          const result = await client.v2.tweet(tweetParams);
          return {
            tweetId: result.data.id,
            url: `https://x.com/${me.data.username}/status/${result.data.id}`,
          };
        } catch (error) {
          console.error('Failed to reply to tweet:', error);
          return null;
        }
      },

      like: async (tweetId: string) => {
        const creds = await twitterOAuth.getAvatarTwitterCredentials(_avatarId);
        if (!creds.configured) return false;

        const { TwitterApi } = await import('twitter-api-v2');
        const client = new TwitterApi({
          appKey: creds.appKey!,
          appSecret: creds.appSecret!,
          accessToken: creds.accessToken!,
          accessSecret: creds.accessSecret!,
        });

        try {
          const me = await client.v2.me();
          await client.v2.like(me.data.id, tweetId);
          return true;
        } catch (error) {
          console.error('Failed to like tweet:', error);
          return false;
        }
      },

      unlike: async (tweetId: string) => {
        const creds = await twitterOAuth.getAvatarTwitterCredentials(_avatarId);
        if (!creds.configured) return false;

        const { TwitterApi } = await import('twitter-api-v2');
        const client = new TwitterApi({
          appKey: creds.appKey!,
          appSecret: creds.appSecret!,
          accessToken: creds.accessToken!,
          accessSecret: creds.accessSecret!,
        });

        try {
          const me = await client.v2.me();
          await client.v2.unlike(me.data.id, tweetId);
          return true;
        } catch (error) {
          console.error('Failed to unlike tweet:', error);
          return false;
        }
      },

      retweet: async (tweetId: string) => {
        const creds = await twitterOAuth.getAvatarTwitterCredentials(_avatarId);
        if (!creds.configured) return false;

        const { TwitterApi } = await import('twitter-api-v2');
        const client = new TwitterApi({
          appKey: creds.appKey!,
          appSecret: creds.appSecret!,
          accessToken: creds.accessToken!,
          accessSecret: creds.accessSecret!,
        });

        try {
          const me = await client.v2.me();
          await client.v2.retweet(me.data.id, tweetId);
          return true;
        } catch (error) {
          console.error('Failed to retweet:', error);
          return false;
        }
      },

      unretweet: async (tweetId: string) => {
        const creds = await twitterOAuth.getAvatarTwitterCredentials(_avatarId);
        if (!creds.configured) return false;

        const { TwitterApi } = await import('twitter-api-v2');
        const client = new TwitterApi({
          appKey: creds.appKey!,
          appSecret: creds.appSecret!,
          accessToken: creds.accessToken!,
          accessSecret: creds.accessSecret!,
        });

        try {
          const me = await client.v2.me();
          await client.v2.unretweet(me.data.id, tweetId);
          return true;
        } catch (error) {
          console.error('Failed to unretweet:', error);
          return false;
        }
      },

      quoteTweet: async (tweetId: string, text: string, mediaUrls?: string[], galleryIds?: string[]) => {
        const creds = await twitterOAuth.getAvatarTwitterCredentials(_avatarId);
        if (!creds.configured) return null;

        // Resolve gallery IDs to URLs (preferred over raw URLs)
        let resolvedMediaUrls: string[] = [];
        
        if (galleryIds && galleryIds.length > 0) {
          console.log('Quote: Resolving gallery IDs to URLs:', galleryIds);
          for (const galleryId of galleryIds.slice(0, 4)) {
            try {
              const item = await gallery.getGalleryItem(_avatarId, galleryId);
              if (item?.url) {
                resolvedMediaUrls.push(item.url);
              }
            } catch (err) {
              console.error(`Failed to resolve gallery item ${galleryId}:`, err);
            }
          }
        }
        
        if (resolvedMediaUrls.length === 0 && mediaUrls && mediaUrls.length > 0) {
          resolvedMediaUrls = mediaUrls;
        }

        const { TwitterApi } = await import('twitter-api-v2');
        const client = new TwitterApi({
          appKey: creds.appKey!,
          appSecret: creds.appSecret!,
          accessToken: creds.accessToken!,
          accessSecret: creds.accessSecret!,
        });

        try {
          // Get authenticated user for URL construction
          const me = await client.v2.me();

          const twitterMediaIds = resolvedMediaUrls.length > 0
            ? await uploadMediaToTwitter(client, resolvedMediaUrls, _avatarId)
            : undefined;

          const tweetParams: Parameters<typeof client.v2.tweet>[0] = {
            text,
            quote_tweet_id: tweetId,
          };
          if (twitterMediaIds && twitterMediaIds.length > 0) {
            tweetParams.media = { media_ids: twitterMediaIds as [string] };
          }

          const result = await client.v2.tweet(tweetParams);
          return {
            tweetId: result.data.id,
            url: `https://x.com/${me.data.username}/status/${result.data.id}`,
          };
        } catch (error) {
          console.error('Failed to quote tweet:', error);
          return null;
        }
      },
    },

    // =========================================================================
    // Discord Services
    // =========================================================================
    discord: {
      getConnectionStatus: async () => {
        return discord.getConnectionStatus(_avatarId);
      },

      sendMessage: async (channelId, content, options) => {
        return discord.sendMessage(_avatarId, channelId, content, options);
      },

      sendWebhookMessage: async (content, options) => {
        return discord.sendWebhookMessage(_avatarId, content, options);
      },

      getChannel: async (channelId) => {
        return discord.getChannel(_avatarId, channelId);
      },

      listChannels: async (guildId) => {
        return discord.listChannels(_avatarId, guildId);
      },

      listGuilds: async () => {
        return discord.listGuilds(_avatarId);
      },

      getMessages: async (channelId, limit) => {
        return discord.getMessages(_avatarId, channelId, limit);
      },

      addReaction: async (channelId, messageId, emoji) => {
        return discord.addReaction(_avatarId, channelId, messageId, emoji);
      },

      removeReaction: async (channelId, messageId, emoji) => {
        return discord.removeReaction(_avatarId, channelId, messageId, emoji);
      },
    },

    // =========================================================================
    // Integrations Services (Unified Configuration)
    // =========================================================================
    integrations: {
      getStatus: async (integration: IntegrationType) => {
        return integrations.getIntegrationStatus(_avatarId, integration);
      },

      getAllStatuses: async () => {
        return integrations.getAllIntegrationStatuses(_avatarId);
      },

      testConnection: async (integration: IntegrationType) => {
        return integrations.testIntegrationConnection(_avatarId, integration);
      },

      getAvailableModels: (integration?: string, capability?: string) => {
        if (capability && integration) {
          return getModelsForCapability(capability as AICapability, integration);
        } else if (capability) {
          return getModelsForCapability(capability as AICapability);
        } else if (integration) {
          return AVAILABLE_MODELS.filter(m => m.provider === integration);
        }
        return AVAILABLE_MODELS;
      },

      setModelPreference: async (integration: string, capability: string, modelId: string) => {
        return integrations.setModelPreference(
          _avatarId,
          integration as IntegrationType,
          capability as AICapability,
          modelId,
          session
        );
      },
    },

    // =========================================================================
    // NFT Services (Avatar Inhabitation & Lineage)
    // =========================================================================
    nft: createNFTServices(),

    // =========================================================================
    // Property Research Services
    // =========================================================================
    property: createPropertyServices(_avatarId, session),

    // =========================================================================
    // Sticker Services
    // =========================================================================
    stickers: stickers.createStickerServices(),

    // =========================================================================
    // Diagnostics Services (Issues & Feedback)
    // =========================================================================
    diagnostics: {
      recordIssue: async (params) => {
        return avatarvents.recordIssue({
          avatarId: params.avatarId,
          platform: params.platform,
          severity: params.severity,
          category: params.category,
          title: params.title,
          description: params.description,
          userMessage: params.userMessage,
          context: params.context,
        });
      },
      recordFeedback: async (params) => {
        return avatarvents.recordFeedback({
          avatarId: params.avatarId,
          platform: params.platform,
          sentiment: params.sentiment,
          feature: params.feature,
          feedback: params.feedback,
        });
      },
    },

    // =========================================================================
    // MCP Admin Services (Toolset & External Server Management)
    // =========================================================================
    mcpAdmin: createMcpAdminServices(),
  };
}

/**
 * Create NFT services for avatar inhabitation and lineage
 */
function createNFTServices(): NFTServices {
  return {
    // Gate NFT operations
    getGateStatus: async (walletAddress: string) => {
      return nftGate.getGateStatus(walletAddress);
    },

    getGateCollectionAddress: () => {
      return nftGate.getGateCollection();
    },

    // Inhabitation operations
    getInhabitationInfo: async (walletAddress: string) => {
      return avatarwnership.getInhabitationInfo(walletAddress);
    },

    listUnclaimedAvatars: async () => {
      // Get all avatars without an inhabitant
      const allAgents = await avatars.listAvatars();
      return allAgents
        .filter((avatar) => !avatar.inhabitantWallet)
        .map((avatar) => ({
          avatarId: avatar.avatarId,
          name: avatar.name,
          description: avatar.description,
          avatarUrl: avatar.profileImage?.url,
          era: avatar.currentEra || 0,
        }));
    },

    inhabitAvatar: async (walletAddress: string, avatarId: string) => {
      return avatarwnership.inhabitAvatar(walletAddress, avatarId);
    },

    canAbandon: async (walletAddress: string) => {
      const result = await avatarwnership.canAbandon(walletAddress);
      return {
        canAbandon: result.canAbandon,
        gateStatus: result.gateStatus,
        inhabitedAvatarId: result.inhabitedAvatar?.avatarId,
        inhabitedAvatarName: result.inhabitedAvatar?.name,
      };
    },

    abandonAvatar: async (walletAddress: string, burnTxSignature: string) => {
      return avatarwnership.abandonAvatar(walletAddress, burnTxSignature);
    },

    // Burn verification
    verifyGateBurn: async (walletAddress: string, signature: string) => {
      return lineageNft.verifyGateBurn(walletAddress, signature);
    },

    // Lineage NFT operations
    getLineageCollection: async (avatarId: string) => {
      return lineageNft.getLineageCollection(avatarId);
    },

    prepareLineageMint: async (avatarId: string, walletAddress: string) => {
      return lineageNft.prepareLineageMint(avatarId, walletAddress);
    },

    recordLineageMint: async (
      avatarId: string,
      walletAddress: string,
      nftMint: string,
      era: number,
      burnSignature?: string
    ) => {
      return lineageNft.recordLineageMint(avatarId, walletAddress, nftMint, era, burnSignature);
    },

    generateLineageMetadata: (metadata) => {
      return lineageNft.generateLineageMetadataJson(metadata);
    },

    // Avatar self-awareness (what avatars can actually use)
    getAvatarInhabitationStatus: async (avatarId: string) => {
      const avatar = await avatars.getAvatar(avatarId);
      if (!avatar) {
        return {
          isInhabited: false,
          currentEra: 0,
          totalEras: 0,
        };
      }

      return {
        isInhabited: !!avatar.inhabitantWallet,
        inhabitantWallet: avatar.inhabitantWallet,
        inhabitedAt: avatar.inhabitedAt,
        currentEra: avatar.currentEra || 0,
        totalEras: avatar.currentEra || 0, // Era increments on each abandon
      };
    },

    getInhabitationUrl: (avatarId: string) => {
      // URL to the inhabitation page for this avatar
      const baseUrl = process.env.ADMIN_UI_URL || 'https://swarm.rati.chat';
      return `${baseUrl}/inhabit/${avatarId}`;
    },
  };
}

/**
 * Create MCP services for Telegram context (minimal session)
 */
export function createTelegramMCPServices(avatarId: string): AllServices {
  const telegramSession: UserSession = {
    email: 'telegram-user@telegram.bot',
    userId: `telegram-${avatarId}`,
    isAdmin: false,
    accessToken: '',
  };
  return createMCPServices(avatarId, telegramSession);
}

/**
 * Create property research services
 */
function createPropertyServices(_avatarId: string, _session: UserSession): PropertyServices {
  const webSearch = createWebSearch();

  const isPropertyResearchStatus = (
    value: string
  ): value is 'queued' | 'researching' | 'completed' | 'failed' => {
    return value === 'queued' || value === 'researching' || value === 'completed' || value === 'failed';
  };

  return {
    // Authorization
    checkAuth: async (avatarId: string, walletAddress: string) => {
      return propertyResearch.checkAuth(avatarId, walletAddress);
    },

    grantAuth: async (avatarId: string, walletAddress: string) => {
      await propertyResearch.grantAuth(avatarId, walletAddress);
    },

    revokeAuth: async (avatarId: string, walletAddress: string) => {
      await propertyResearch.revokeAuth(avatarId, walletAddress);
    },

    // Job management
    createJob: async (avatarId: string, property, requestedBy) => {
      return propertyResearch.createJob(avatarId, property, requestedBy);
    },

    getJob: async (jobId: string) => {
      return propertyResearch.getJob(jobId);
    },

    getJobsForAvatar: async (avatarId: string, statusFilter?: string) => {
      const parsedStatus = statusFilter && isPropertyResearchStatus(statusFilter) ? statusFilter : undefined;
      return propertyResearch.getJobsForAvatar(avatarId, parsedStatus);
    },

    deleteJob: async (jobId: string) => {
      await propertyResearch.deleteJob(jobId);
    },

    // Research execution
    executeResearch: async (jobId: string) => {
      return propertyResearch.executeResearch(jobId, webSearch);
    },
  };
}
