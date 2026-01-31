/**
 * Platform MCP Services Adapter
 * 
 * Bridges core services to MCP tool interfaces for platform handlers.
 * This is the production equivalent of admin-api's mcp-adapter.ts,
 * designed for use in Lambda handlers processing Telegram/Discord/Twitter messages.
 */
import type { AllServices } from '@swarm/mcp-server';
import type {
  AvatarConfig,
  StateService,
  MediaService,
} from '@swarm/core';
import { TwitterAdapter } from '@swarm/core';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { createVoiceServices } from './voice.js';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ADMIN_TABLE = process.env.ADMIN_TABLE || 'SwarmAdmin-prod';

export interface PlatformServicesConfig {
  avatarId: string;
  avatarConfig: AvatarConfig;
  stateService: StateService;
  mediaService?: MediaService;
  secrets: Record<string, string>;
  wallets?: Array<{ name: string; publicKey: string; address?: string; walletType: 'solana' | 'ethereum' }>;
  mediaBucket?: string;
  cdnUrl?: string;
}

/**
 * Create MCP-compatible services for platform handlers
 * 
 * This is a lighter-weight adapter than admin-api's version since
 * platform handlers don't need all admin features (secrets management,
 * avatar CRUD, etc.)
 */
export function createPlatformMCPServices(config: PlatformServicesConfig): AllServices {
  const { avatarId, avatarConfig, stateService, mediaService, wallets } = config;
  const voiceServices = createVoiceServices({
    avatarId,
    secrets: config.secrets,
    voiceConfig: avatarConfig.voice,
    mediaBucket: config.mediaBucket,
    cdnUrl: config.cdnUrl,
  });
  const twitterConfig = avatarConfig.platforms?.twitter;
  const twitterAdapter = twitterConfig
    ? new TwitterAdapter(avatarConfig, {
      appKey: config.secrets.TWITTER_API_KEY,
      appSecret: config.secrets.TWITTER_API_SECRET,
      accessToken: config.secrets.TWITTER_ACCESS_TOKEN,
      accessSecret: config.secrets.TWITTER_ACCESS_SECRET,
    })
    : null;
  let cachedTwitterUsername: string | undefined;

  function normalizeCdnUrl(raw?: string): string | undefined {
    if (!raw) return undefined;
    const trimmed = raw.trim().replace(/\/+$/, '');
    if (!trimmed) return undefined;
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  }

  function resolveMediaUrls(mediaUrls?: string[], mediaIds?: string[]): string[] {
    const resolved: string[] = [];

    if (mediaUrls && mediaUrls.length > 0) {
      resolved.push(...mediaUrls);
    }

    if (resolved.length === 0 && mediaIds && mediaIds.length > 0) {
      const cdnBase = normalizeCdnUrl(config.cdnUrl);
      const bucket = config.mediaBucket;
      for (const id of mediaIds.slice(0, 4)) {
        if (/^https?:\/\//i.test(id)) {
          resolved.push(id);
          continue;
        }
        if (cdnBase) {
          resolved.push(`${cdnBase}/${id.replace(/^\/+/, '')}`);
          continue;
        }
        if (bucket) {
          resolved.push(`https://${bucket}.s3.amazonaws.com/${encodeURI(id.replace(/^\/+/, ''))}`);
        }
      }
    }

    return resolved;
  }

  function inferMediaType(url: string): 'image' | 'video' {
    const lower = url.toLowerCase();
    if (lower.endsWith('.mp4')) return 'video';
    return 'image';
  }

  function getTwitterClient() {
    if (!twitterAdapter || !twitterAdapter.isConfigured()) {
      throw new Error('Twitter not configured');
    }
    const client = twitterAdapter.getClient();
    if (!client) {
      throw new Error('Twitter client not initialized');
    }
    return client;
  }

  async function getTwitterUsername(): Promise<string | undefined> {
    if (cachedTwitterUsername) return cachedTwitterUsername;
    if (twitterConfig?.username) {
      cachedTwitterUsername = twitterConfig.username;
      return cachedTwitterUsername;
    }
    try {
      const client = getTwitterClient();
      const me = await client.v2.me();
      cachedTwitterUsername = me.data.username;
      return cachedTwitterUsername;
    } catch {
      return undefined;
    }
  }

  return {
    // =========================================================================
    // Media Services
    // =========================================================================
    media: {
      generateImage: async (params: { prompt: string; aspectRatio?: string; platform?: string; referenceImageUrls?: string[] }) => {
        if (!mediaService) {
          throw new Error('Media service not configured');
        }
        // Validate and default aspect ratio
        const validRatios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9'] as const;
        const aspectRatio = validRatios.includes(params.aspectRatio as typeof validRatios[number])
          ? params.aspectRatio as typeof validRatios[number]
          : '1:1';
        const mediaConfig = {
          ...avatarConfig.media.image,
          aspectRatio,
        };
        const result = await mediaService.generateImage(params.prompt, mediaConfig, {
          avatarId,
          platform: params.platform,
          saveToGallery: true,
          checkCredits: true,
          referenceImageUrls: params.referenceImageUrls,
        });
        return { id: result.s3Key || 'generated', url: result.url };
      },

      generateVideo: async (params: { prompt: string }) => {
        if (!mediaService || !avatarConfig.media.video) {
          throw new Error('Video generation not configured');
        }
        const result = await mediaService.generateVideo(params.prompt, avatarConfig.media.video);
        return { jobId: result.s3Key || `video-${Date.now()}`, status: 'processing' };
      },

      generateSticker: async (params: { prompt?: string; platform?: string }) => {
        if (!mediaService) {
          throw new Error('Media service not configured');
        }
        const stickerPrompt = `sticker style, ${params.prompt || 'cute character'}, white background, simple design`;
        const result = await mediaService.generateImage(stickerPrompt, avatarConfig.media.image, {
          avatarId,
          platform: params.platform,
          saveToGallery: true,
          checkCredits: true,
        });
        return { id: result.s3Key || 'sticker', url: result.url };
      },

      getProfileImageUrl: async () => {
        return avatarConfig.profileImage?.url;
      },
      getReferenceImageUrl: async (_avatarId: string, category?: string) => {
        // For 'character' category, prefer characterReference
        if (category === 'character' && avatarConfig.characterReference?.url) {
          return avatarConfig.characterReference.url;
        }
        // Fall back to profile image
        return avatarConfig.profileImage?.url;
      },
      getCharacterReferenceUrl: async () => {
        return avatarConfig.characterReference?.url;
      },
      getBestReferenceImageUrl: async () => {
        // Prefer character reference for full-body consistency
        if (avatarConfig.characterReference?.url) {
          return avatarConfig.characterReference.url;
        }
        // Fall back to profile image
        return avatarConfig.profileImage?.url;
      },
    },

    // =========================================================================
    // Media Credits (no-op for platform - credits managed separately)
    // =========================================================================
    mediaCredits: {
      canUseTool: async () => ({ allowed: true }),
      consumeCredit: async () => true,
    },

    // =========================================================================
    // Job Credits (no-op for platform)
    // =========================================================================
    jobCredits: {
      getToolStatus: async () => ({
        generate_image: { used: 0, limit: 100, remaining: 100 },
        generate_video: { used: 0, limit: 10, remaining: 10 },
        generate_sticker: { used: 0, limit: 50, remaining: 50 },
      }),
      getEnergyStatus: async () => ({
        current: 10,
        max: 10,
        nextRefillIn: 0,
      }),
    },

    // =========================================================================
    // Gallery Services (platform has read access to gallery)
    // =========================================================================
    gallery: {
      getGallery: async (_avatarId: string, options?: { type?: 'image' | 'video' | 'sticker'; limit?: number }) => {
        try {
          const result = await dynamoClient.send(new QueryCommand({
            TableName: ADMIN_TABLE,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
            ExpressionAttributeValues: {
              ':pk': `AVATAR#${avatarId}`,
              ':sk': 'GALLERY#',
            },
            ScanIndexForward: false, // Most recent first
            Limit: (options?.limit || 20) * 2,
          }));
          let items = (result.Items || []) as Array<{
            id: string;
            url: string;
            s3Key: string;
            type: string;
            prompt?: string;
            platform?: string;
            createdAt: number;
            postedToTwitter?: boolean;
          }>;
          if (options?.type) {
            items = items.filter(item => item.type === options.type);
          }
          return items.slice(0, options?.limit || 20).map(item => ({
            id: item.id,
            url: item.url,
            s3Key: item.s3Key,
            type: item.type as 'image' | 'video' | 'sticker',
            prompt: item.prompt,
            platform: item.platform,
            createdAt: item.createdAt,
          }));
        } catch {
          return [];
        }
      },
      getGalleryItem: async (_avatarId: string, itemId: string) => {
        try {
          const result = await dynamoClient.send(new QueryCommand({
            TableName: ADMIN_TABLE,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
            FilterExpression: 'id = :id',
            ExpressionAttributeValues: {
              ':pk': `AVATAR#${avatarId}`,
              ':sk': 'GALLERY#',
              ':id': itemId,
            },
            Limit: 100,
          }));
          const item = result.Items?.[0] as {
            id: string;
            url: string;
            s3Key: string;
            type: string;
            prompt?: string;
            platform?: string;
            createdAt: number;
          } | undefined;
          if (!item) return null;
          return {
            id: item.id,
            url: item.url,
            s3Key: item.s3Key,
            type: item.type as 'image' | 'video' | 'sticker',
            prompt: item.prompt,
            platform: item.platform,
            createdAt: item.createdAt,
          };
        } catch {
          return null;
        }
      },
      searchGallery: async (_avatarId: string, query: string, _type?: 'image' | 'video' | 'sticker') => {
        // Simple search by prompt text
        try {
          const result = await dynamoClient.send(new QueryCommand({
            TableName: ADMIN_TABLE,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
            ExpressionAttributeValues: {
              ':pk': `AVATAR#${avatarId}`,
              ':sk': 'GALLERY#',
            },
            ScanIndexForward: false,
            Limit: 100,
          }));
          const items = (result.Items || []) as Array<{
            id: string;
            url: string;
            s3Key: string;
            type: string;
            prompt?: string;
            platform?: string;
            createdAt: number;
          }>;
          const lowerQuery = query.toLowerCase();
          return items
            .filter(item => item.prompt?.toLowerCase().includes(lowerQuery))
            .slice(0, 20)
            .map(item => ({
              id: item.id,
              url: item.url,
              s3Key: item.s3Key,
              type: item.type as 'image' | 'video' | 'sticker',
              prompt: item.prompt,
              platform: item.platform,
              createdAt: item.createdAt,
            }));
        } catch {
          return [];
        }
      },
    },

    // =========================================================================
    // Wallet Services
    // =========================================================================
    wallets: {
      listWallets: async () => {
        if (!wallets) return [];
        return wallets
          .map(w => ({
            name: w.name,
            publicKey: w.publicKey,
            address: w.address,
            walletType: w.walletType as 'solana' | 'ethereum',
            balance: 0,
            solBalance: w.walletType === 'solana' ? 0 : undefined,
            ethBalance: w.walletType === 'ethereum' ? 0 : undefined,
          }));
      },

      createWallet: async () => {
        throw new Error('Wallet creation not allowed from platform handlers');
      },

      getBalance: async (_publicKey: string, _avatarId: string, chain = 'solana') => ({
        balance: 0,
        chain,
        solBalance: chain === 'solana' ? 0 : undefined,
        solBalanceLamports: chain === 'solana' ? 0 : undefined,
        ethBalance: chain === 'ethereum' ? 0 : undefined,
        tokens: [],
      }),
    },

    // =========================================================================
    // Model Services (read-only for platform)
    // =========================================================================
    models: {
      listModels: async () => [],
      getConfig: async () => ({
        model: avatarConfig.llm.model,
        provider: avatarConfig.llm.provider,
        temperature: avatarConfig.llm.temperature,
        maxTokens: avatarConfig.llm.maxTokens,
      }),
      updateConfig: async () => {
        throw new Error('Model changes not allowed from platform handlers');
      },
    },

    // =========================================================================
    // Profile Services (read-only for platform)
    // =========================================================================
    profile: {
      getProfile: async () => ({
        name: avatarConfig.name,
        persona: avatarConfig.persona,
      }),
      updateProfile: async () => {
        throw new Error('Profile updates not allowed from platform handlers');
      },
      setProfileImage: async () => {
        throw new Error('Profile uploads not allowed from platform handlers');
      },
      getProfileUploadUrl: async () => {
        throw new Error('Profile uploads not allowed from platform handlers');
      },
      saveProfileImage: async () => {
        throw new Error('Profile uploads not allowed from platform handlers');
      },
    },

    // =========================================================================
    // Secrets Services (no access from platform)
    // =========================================================================
    secrets: {
      listSecrets: async () => [],
      storeSecret: async () => {
        throw new Error('Secret management not allowed from platform handlers');
      },
      validateTelegramToken: async (token: string) => {
        return { valid: !!token, error: token ? undefined : 'No token' };
      },
    },

    // =========================================================================
    // Jobs Services (simplified for platform)
    // =========================================================================
    jobs: {
      getPendingJobs: async () => [],
      getJob: async () => null,
    },

    // =========================================================================
    // Reference Images (not available from platform)
    // =========================================================================
    reference: {
      listReferenceImages: async () => [],
      getUploadUrl: async () => {
        throw new Error('Reference uploads not allowed from platform handlers');
      },
      saveReferenceImage: async () => {
        throw new Error('Reference uploads not allowed from platform handlers');
      },
      deleteReferenceImage: async () => {
        throw new Error('Reference deletes not allowed from platform handlers');
      },
    },

    // =========================================================================
    // Memory Services (wired to state service!)
    // =========================================================================
    memory: {
      remember: async (fact: string, about?: string, userId?: string) => {
        await stateService.saveFact(avatarId, {
          fact,
          about,
          userId,
          timestamp: Date.now(),
        });
        return { saved: true };
      },

      recall: async (query: string, userId?: string) => {
        const facts = await stateService.getFacts(avatarId, query, userId);
        return { facts };
      },
    },

    // =========================================================================
    // Voice Services
    // =========================================================================
    voice: voiceServices,

    // =========================================================================
    // Twitter Services (platform runtime)
    // =========================================================================
    ...(twitterConfig?.enabled && twitterAdapter ? {
      twitter: {
        getConnectionStatus: async () => {
          const connected = twitterAdapter.isConfigured();
          return {
            connected,
            username: twitterConfig.username,
            charLimit: twitterConfig.charLimit,
            verifiedType: twitterConfig.verifiedType,
          };
        },

        startOAuthFlow: async () => null,

        postTweet: async (text: string, mediaUrls?: string[], mediaIds?: string[]) => {
          try {
            if (!twitterAdapter.isConfigured()) {
              return { error: 'Twitter is not configured. Please connect Twitter first.' };
            }
            const resolvedMediaUrls = resolveMediaUrls(mediaUrls, mediaIds);
            const media = resolvedMediaUrls.map(url => ({ type: inferMediaType(url), url }));
            const tweetId = await twitterAdapter.postTweet(text, media.length > 0 ? media : undefined);
            const username = await getTwitterUsername();
            return {
              tweetId,
              url: username ? `https://x.com/${username}/status/${tweetId}` : `https://x.com/i/web/status/${tweetId}`,
            };
          } catch (error) {
            return { error: error instanceof Error ? error.message : 'Failed to post tweet' };
          }
        },

        getTimeline: async (count = 20) => {
          try {
            const client = getTwitterClient();
            const userId = await twitterAdapter.getBotUserId();
            const timeline = await client.v2.userTimeline(userId, {
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
          } catch {
            return [];
          }
        },

        getMentions: async (sinceId?: string, count = 20) => {
          try {
            const client = getTwitterClient();
            const userId = await twitterAdapter.getBotUserId();
            const mentions = await client.v2.userMentionTimeline(userId, {
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
          } catch {
            return [];
          }
        },

        getTweet: async (tweetId: string) => {
          try {
            const client = getTwitterClient();
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
          } catch {
            return null;
          }
        },

        reply: async (tweetId: string, text: string, mediaUrls?: string[], mediaIds?: string[]) => {
          try {
            const resolvedMediaUrls = resolveMediaUrls(mediaUrls, mediaIds);
            const media = resolvedMediaUrls.map(url => ({ type: inferMediaType(url), url }));
            const replyId = await twitterAdapter.postTweet(text, media.length > 0 ? media : undefined, tweetId);
            const username = await getTwitterUsername();
            return {
              tweetId: replyId,
              url: username ? `https://x.com/${username}/status/${replyId}` : `https://x.com/i/web/status/${replyId}`,
            };
          } catch {
            return null;
          }
        },

        like: async (tweetId: string) => {
          try {
            const client = getTwitterClient();
            const userId = await twitterAdapter.getBotUserId();
            await client.v2.like(userId, tweetId);
            return true;
          } catch {
            return false;
          }
        },

        unlike: async (tweetId: string) => {
          try {
            const client = getTwitterClient();
            const userId = await twitterAdapter.getBotUserId();
            await client.v2.unlike(userId, tweetId);
            return true;
          } catch {
            return false;
          }
        },

        retweet: async (tweetId: string) => {
          try {
            const client = getTwitterClient();
            const userId = await twitterAdapter.getBotUserId();
            await client.v2.retweet(userId, tweetId);
            return true;
          } catch {
            return false;
          }
        },

        unretweet: async (tweetId: string) => {
          try {
            const client = getTwitterClient();
            const userId = await twitterAdapter.getBotUserId();
            await client.v2.unretweet(userId, tweetId);
            return true;
          } catch {
            return false;
          }
        },

        quoteTweet: async (tweetId: string, text: string, mediaUrls?: string[], mediaIds?: string[]) => {
          try {
            const resolvedMediaUrls = resolveMediaUrls(mediaUrls, mediaIds);
            const media = resolvedMediaUrls.map(url => ({ type: inferMediaType(url), url }));
            const quoteId = await twitterAdapter.quoteTweet(text, tweetId, media.length > 0 ? media : undefined);
            const username = await getTwitterUsername();
            return {
              tweetId: quoteId,
              url: username ? `https://x.com/${username}/status/${quoteId}` : `https://x.com/i/web/status/${quoteId}`,
            };
          } catch {
            return null;
          }
        },

        getActivitySummary: async () => {
          try {
            const mentions = await (async () => {
              const client = getTwitterClient();
              const userId = await twitterAdapter.getBotUserId();
              const result = await client.v2.userMentionTimeline(userId, {
                max_results: 10,
                'tweet.fields': ['created_at'],
              });
              return result.data.data || [];
            })();

            return {
              pendingMentions: mentions.length,
              lastMentionAt: mentions[0]?.created_at,
              summary: mentions.length > 0
                ? `${mentions.length} pending mention(s) to review`
                : 'No pending mentions',
            };
          } catch {
            return null;
          }
        },
      },
    } : {}),
  };
}
