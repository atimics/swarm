/**
 * Autonomous Tweet Poster - Shared Multi-Tenant Handler
 *
 * Runs hourly (handler manages per-avatar timing internally)
 * Posts memory-integrated content to Twitter and Communities
 *
 * Features:
 * - 4-6 hour randomized posting intervals per avatar
 * - Memory-integrated content generation
 * - Optional image generation (configurable probability)
 * - Community posting support (when available)
 */
import type { ScheduledHandler, Context } from 'aws-lambda';
import {
  TwitterAdapter,
  createStateService,
  createSecretsService,
  createActivityService,
  createLLMService,
  createMediaServiceWithDeps,
  createMediaDependencies,
  logger,
  type AvatarConfig,
} from '@swarm/core';
import {
  generateAutonomousContent,
  generateImagePrompt,
  type AutonomousContentTargetType,
  type CommunityContext,
} from './services/autonomous-content.js';

const STATE_TABLE = process.env.STATE_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const MEDIA_BUCKET = process.env.MEDIA_BUCKET!;
const CDN_URL = process.env.CDN_URL;
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'swarm';

let stateService: ReturnType<typeof createStateService>;
let activityService: ReturnType<typeof createActivityService>;
let secretsService: ReturnType<typeof createSecretsService>;

async function initialize(): Promise<void> {
  if (stateService) return;
  stateService = createStateService(STATE_TABLE);
  activityService = createActivityService(ACTIVITY_TABLE);
  secretsService = createSecretsService();
}

/**
 * Check if an avatar is ready for an autonomous post based on timing configuration
 */
function shouldPostNow(
  lastPostTime: number,
  minIntervalHours: number,
  maxIntervalHours: number
): boolean {
  const now = Date.now();
  const minIntervalMs = minIntervalHours * 60 * 60 * 1000;
  const maxIntervalMs = maxIntervalHours * 60 * 60 * 1000;

  // Calculate a randomized interval for this check
  // Using a deterministic random based on lastPostTime for consistency
  const seed = lastPostTime || now;
  const randomFactor = (seed % 1000) / 1000; // 0-1 based on seed
  const requiredInterval = minIntervalMs + randomFactor * (maxIntervalMs - minIntervalMs);

  return now - lastPostTime >= requiredInterval;
}

/**
 * Process a single avatar for autonomous posting
 */
async function processAvatar(
  avatarId: string,
  avatarConfig: AvatarConfig,
  secrets: Record<string, string>
): Promise<{ posted: boolean; tweetId?: string; error?: string }> {
  const twitterConfig = avatarConfig.platforms.twitter;
  if (!twitterConfig?.enabled) {
    return { posted: false };
  }

  // Check if autonomous posts feature is enabled
  if (!twitterConfig.features?.includes('autonomous_posts')) {
    return { posted: false };
  }

  const autoConfig = twitterConfig.autonomousPosts;
  if (!autoConfig?.enabled) {
    return { posted: false };
  }

  // Check timing
  const lastPostTime = await stateService.getLastAutonomousPostTime(avatarId);
  const minInterval = autoConfig.minIntervalHours || 4;
  const maxInterval = autoConfig.maxIntervalHours || 6;

  if (!shouldPostNow(lastPostTime, minInterval, maxInterval)) {
    logger.debug('Skipping avatar, not enough time elapsed', {
      avatarId,
      lastPostTime,
      minInterval,
      maxInterval,
    });
    return { posted: false };
  }

  // Initialize Twitter adapter
  const twitterAdapter = new TwitterAdapter(avatarConfig, {
    appKey: secrets.TWITTER_API_KEY,
    appSecret: secrets.TWITTER_API_SECRET,
    accessToken: secrets.TWITTER_ACCESS_TOKEN,
    accessSecret: secrets.TWITTER_ACCESS_SECRET,
  });

  if (!twitterAdapter.isConfigured()) {
    return { posted: false, error: 'Twitter adapter not configured' };
  }

  // Initialize LLM service
  const llmService = createLLMService(avatarConfig.llm, secrets);

  // Decide: regular tweet or community post
  const communities = twitterConfig.communities || [];
  const hasCommunityFeature = twitterConfig.features?.includes('community_posts');
  const shouldPostToCommunity = hasCommunityFeature && communities.length > 0 && Math.random() < 0.3;

  let targetType: AutonomousContentTargetType = 'tweet';
  let communityContext: CommunityContext | undefined;

  if (shouldPostToCommunity) {
    const community = communities[Math.floor(Math.random() * communities.length)];
    targetType = 'community_post';
    communityContext = { id: community.id, name: community.name };
  }

  // Generate content with memory integration
  const content = await generateAutonomousContent(
    {
      avatarId,
      avatarConfig,
      targetType,
      communityContext,
    },
    stateService,
    llmService
  );

  // Optionally generate image
  let mediaUrl: string | undefined;
  const imageChance = autoConfig.imageChance ?? 0.3;

  if (Math.random() < imageChance) {
    try {
      const mediaDeps = createMediaDependencies({ tableName: STATE_TABLE });
      const mediaService = createMediaServiceWithDeps(secrets, MEDIA_BUCKET, CDN_URL, mediaDeps);

      const imagePrompt = await generateImagePrompt(content.text, avatarConfig, llmService);

      const media = await mediaService.generateImage(
        imagePrompt,
        avatarConfig.media.image,
        { avatarId, platform: 'twitter', saveToGallery: true, checkCredits: true }
      );
      mediaUrl = media.url;

      logger.info('Generated image for autonomous post', {
        event: 'image_generated',
        avatarId,
        imagePrompt: imagePrompt.slice(0, 50),
      });
    } catch (error) {
      logger.warn('Image generation failed for autonomous post', { error, avatarId });
      // Continue without image
    }
  }

  // Post the tweet
  let tweetId: string;
  if (targetType === 'community_post' && communityContext) {
    tweetId = await twitterAdapter.postToCommunity(
      communityContext.id,
      content.text,
      mediaUrl ? [{ type: 'image', url: mediaUrl }] : undefined
    );
  } else {
    tweetId = await twitterAdapter.postTweet(
      content.text,
      mediaUrl ? [{ type: 'image', url: mediaUrl }] : undefined
    );
  }

  // Record the post time
  await stateService.setLastAutonomousPostTime(avatarId, Date.now());

  // Log activity
  await activityService.log({
    avatarId,
    timestamp: Date.now(),
    eventType: 'response_sent',
    platform: 'twitter',
    summary: `Autonomous ${targetType}: ${content.text.slice(0, 50)}...`,
    details: {
      tweetId,
      hasImage: !!mediaUrl,
      targetType,
      communityId: communityContext?.id,
      communityName: communityContext?.name,
    },
  });

  return { posted: true, tweetId };
}

export const handler: ScheduledHandler = async (_event, context: Context) => {
  const startTime = Date.now();
  logger.setContext({
    requestId: context.awsRequestId,
    handler: 'autonomous-tweet-poster',
  });

  await initialize();

  logger.info('Autonomous tweet poster started', {
    event: 'handler_started',
    subsystem: 'twitter',
  });

  // Get all avatars
  const avatarIds = await stateService.listAvatars();
  let postsCreated = 0;
  let avatarsProcessed = 0;
  let avatarsSkipped = 0;
  const errors: Array<{ avatarId: string; error: string }> = [];

  for (const avatarId of avatarIds) {
    try {
      logger.setContext({ avatarId, requestId: context.awsRequestId });

      const avatarConfig = await stateService.getAvatarConfig(avatarId);
      if (!avatarConfig) {
        logger.debug('Avatar config not found', { avatarId });
        continue;
      }

      // Quick check for autonomous posts feature before loading secrets
      const twitterConfig = avatarConfig.platforms?.twitter;
      if (!twitterConfig?.enabled || !twitterConfig.features?.includes('autonomous_posts')) {
        avatarsSkipped++;
        continue;
      }

      if (!twitterConfig.autonomousPosts?.enabled) {
        avatarsSkipped++;
        continue;
      }

      const secrets = await secretsService.getSecretJson<Record<string, string>>(
        `${SECRET_PREFIX}/${avatarId}/secrets`
      );

      const result = await processAvatar(avatarId, avatarConfig, secrets);
      avatarsProcessed++;

      if (result.posted) {
        postsCreated++;
        logger.info('Autonomous post created', {
          event: 'autonomous_post_created',
          tweetId: result.tweetId,
        });
      }

      if (result.error) {
        errors.push({ avatarId, error: result.error });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to process avatar for autonomous posting', error, { avatarId });
      errors.push({ avatarId, error: errorMessage });
    }
  }

  logger.info('Autonomous tweet poster complete', {
    event: 'handler_complete',
    postsCreated,
    avatarsProcessed,
    avatarsSkipped,
    errorCount: errors.length,
    errors: errors.length > 0 ? errors : undefined,
    durationMs: Date.now() - startTime,
  });
};
