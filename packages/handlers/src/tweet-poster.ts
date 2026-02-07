/**
 * Tweet Poster Handler
 * Posts scheduled tweets with optional AI-generated images
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
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_PROVIDER,
  type AvatarConfig,
} from '@swarm/core';
import { ensureReplicateKey } from './utils/system-replicate-key.js';
import { loadAvatarSecrets } from './utils/load-avatar-secrets.js';
import { checkMediaWithEnergyFallback } from './services/entitlement-enforcement.js';

// Environment variables
const STATE_TABLE = process.env.STATE_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const MEDIA_BUCKET = process.env.MEDIA_BUCKET!;
const CDN_URL = process.env.CDN_URL;
const AVATAR_ID = process.env.AVATAR_ID!;
const TWEET_TEMPLATE = process.env.TWEET_TEMPLATE || 'general';

// Services
let stateService: ReturnType<typeof createStateService>;
let activityService: ReturnType<typeof createActivityService>;
let secretsService: ReturnType<typeof createSecretsService>;
let twitterAdapter: TwitterAdapter;
let secrets: Record<string, string>;
let avatarConfig: AvatarConfig;

async function initialize(): Promise<void> {
  if (stateService) return;

  stateService = createStateService(STATE_TABLE);
  activityService = createActivityService(ACTIVITY_TABLE);
  secretsService = createSecretsService();

  avatarConfig = await stateService.getAvatarConfig(AVATAR_ID) || {
    id: AVATAR_ID,
    name: AVATAR_ID,
    version: '1.0.0',
    persona: '',
    platforms: {
      twitter: { enabled: true, username: '', features: ['scheduled_tweets'] },
    },
    llm: { provider: DEFAULT_LLM_PROVIDER, model: DEFAULT_LLM_MODEL, temperature: 0.9, maxTokens: 1000 },
    media: { image: { provider: 'replicate', model: 'black-forest-labs/flux-schnell' } },
    scheduling: {},
    behavior: { responseDelayMs: [0, 0], typingIndicator: false, ignoreBots: true, cooldownMinutes: 0, maxContextMessages: 0 },
    tools: [],
    secrets: [],
  };

  const secretPrefix = process.env.SECRET_PREFIX || 'swarm';
  secrets = await loadAvatarSecrets(secretsService, AVATAR_ID, secretPrefix, process.env.SECRETS_ARN);

  // Scheduled media generation should work even if the avatar secret JSON omits Replicate.
  try {
    const ok = await ensureReplicateKey(secrets, secretsService);
    if (ok && secrets.REPLICATE_API_KEY) {
      logger.info('Loaded system Replicate key for tweet poster', { subsystem: 'twitter' });
    } else if (!ok) {
      logger.warn('System Replicate key not configured for tweet poster', {
        subsystem: 'twitter',
        hasEnvKey: Boolean(process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY),
        hasSecretArn: Boolean(process.env.REPLICATE_API_KEY_SECRET_ARN),
      });
    }
  } catch (err) {
    logger.warn('Failed to load system Replicate key for tweet poster', {
      subsystem: 'twitter',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  twitterAdapter = new TwitterAdapter(avatarConfig, {
    appKey: secrets.TWITTER_API_KEY,
    appSecret: secrets.TWITTER_API_SECRET,
    accessToken: secrets.TWITTER_ACCESS_TOKEN,
    accessSecret: secrets.TWITTER_ACCESS_SECRET,
  });
}

export const handler: ScheduledHandler = async (_event, context: Context) => {
  const startTime = Date.now();
  logger.setContext({
    avatarId: AVATAR_ID,
    platform: 'twitter',
    requestId: context.awsRequestId,
    template: TWEET_TEMPLATE,
  });

  logger.info('Tweet poster started', {
    event: 'handler_started',
    subsystem: 'twitter',
    template: TWEET_TEMPLATE,
  });

  try {
    await initialize();

    logger.info('Generating scheduled tweet', {
      event: 'llm_request',
      subsystem: 'llm',
    });

    // Generate tweet content using LLM
    const llmService = createLLMService(avatarConfig.llm, secrets);

    // Get character limit from config (premium accounts get 10,000 chars)
    const charLimit = avatarConfig.platforms.twitter?.charLimit ?? 280;
    const isPremium = charLimit > 280;

    logger.info('Twitter character limit', {
      event: 'char_limit_check',
      subsystem: 'twitter',
      charLimit,
      isPremium,
      verifiedType: avatarConfig.platforms.twitter?.verifiedType,
    });

    const systemPrompt = `${avatarConfig.persona}

You are posting a tweet. Generate a single tweet that:
- Is engaging and authentic to your personality
- Is under ${charLimit} characters${isPremium ? ' (you have a premium account with extended limits)' : ''}
- Does not use hashtags excessively (max 1-2 if any)
- Feels natural, not promotional
- Template type: ${TWEET_TEMPLATE}

Respond with ONLY the tweet text, nothing else.`;

    const response = await llmService.generateResponse({
      avatarId: AVATAR_ID,
      systemPrompt,
      messages: [{ role: 'user', content: 'Generate a tweet.' }],
      config: { ...avatarConfig.llm, temperature: 0.95 },
    });

    let tweetText = response.content.trim();

    // Ensure tweet is under the character limit
    if (tweetText.length > charLimit) {
      tweetText = tweetText.slice(0, charLimit - 3) + '...';
    }

    logger.info('Tweet generated', {
      event: 'llm_response',
      subsystem: 'llm',
      text: tweetText,
      length: tweetText.length,
    });

    // Optionally generate an image
    let mediaUrl: string | undefined;
    
    // 30% chance to include an image
    if (Math.random() < 0.3) {
      try {
        // Unified burst pool: entitlement-first, energy-fallback
        const usageCheck = await checkMediaWithEnergyFallback(AVATAR_ID);
        if (!usageCheck.allowed) {
          throw new Error(usageCheck.reason || 'Daily media generation limit reached');
        }

        const mediaDeps = createMediaDependencies({ tableName: STATE_TABLE });
        const mediaService = createMediaServiceWithDeps(secrets, MEDIA_BUCKET, CDN_URL, mediaDeps);

        const imagePromptResponse = await llmService.generateResponse({
          avatarId: AVATAR_ID,
          systemPrompt: `Generate a short image prompt (under 100 chars) for an image to accompany this tweet: "${tweetText}"
          
The image should be visually interesting and relate to the tweet content.
Respond with ONLY the image prompt, nothing else.`,
          messages: [{ role: 'user', content: 'Generate image prompt.' }],
          config: { ...avatarConfig.llm, maxTokens: 100 },
        });

        const imagePrompt = imagePromptResponse.content.trim();
        logger.info('Generating tweet image', {
          event: 'media_request',
          subsystem: 'media',
          prompt: imagePrompt,
        });

        const media = await mediaService.generateImage(imagePrompt, avatarConfig.media.image, {
          avatarId: AVATAR_ID,
          platform: 'twitter',
          saveToGallery: true,
          checkCredits: false,
        });
        mediaUrl = media.url;
        
        logger.info('Image generated', {
          event: 'media_response',
          subsystem: 'media',
          url: mediaUrl,
        });
      } catch (error) {
        logger.warn('Image generation failed, posting without image', {
          event: 'media_error',
          subsystem: 'media',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Post the tweet
    const tweetId = await twitterAdapter.postTweet(
      tweetText,
      mediaUrl ? [{ type: 'image', url: mediaUrl }] : undefined
    );

    logger.info('Tweet posted', {
      event: 'tweet_posted',
      subsystem: 'twitter',
      tweetId,
      hasImage: !!mediaUrl,
      durationMs: Date.now() - startTime,
    });

    // Log activity
    await activityService.log({
      avatarId: AVATAR_ID,
      timestamp: Date.now(),
      eventType: 'response_sent',
      platform: 'twitter',
      summary: `Posted tweet: ${tweetText.slice(0, 50)}...`,
      details: { tweetId, hasImage: !!mediaUrl },
    });

  } catch (error) {
    logger.error('Failed to post tweet', error, {
      event: 'handler_error',
      subsystem: 'twitter',
      durationMs: Date.now() - startTime,
    });
    
    await activityService.logError(
      AVATAR_ID,
      'twitter',
      error instanceof Error ? error.message : String(error)
    );
    
    throw error;
  }
};
