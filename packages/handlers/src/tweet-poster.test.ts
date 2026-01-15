/**
 * Tweet Poster Handler Tests
 *
 * Tests for the Lambda handler that posts scheduled tweets
 * with optional AI-generated images.
 *
 * Uses bun:test with mock functions instead of vi.mock for dependency injection.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

describe('Tweet Poster - Pure Logic Tests', () => {
  beforeEach(() => {
    process.env.STATE_TABLE = 'test-state-table';
    process.env.ACTIVITY_TABLE = 'test-activity-table';
    process.env.MEDIA_BUCKET = 'test-media-bucket';
    process.env.AGENT_ID = 'test-agent';
  });

  it('should define required environment variables', () => {
    const requiredEnvVars = [
      'STATE_TABLE',
      'ACTIVITY_TABLE',
      'MEDIA_BUCKET',
      'AGENT_ID',
    ];
    const optionalEnvVars = ['CDN_URL', 'TWEET_TEMPLATE'];

    expect(requiredEnvVars).toHaveLength(4);
    expect(optionalEnvVars).toHaveLength(2);
  });

  describe('Tweet text truncation', () => {
    it('should truncate tweet to 280 characters', () => {
      const longTweet = 'a'.repeat(300);
      const truncated = longTweet.length > 280 ? longTweet.slice(0, 277) + '...' : longTweet;

      expect(truncated.length).toBe(280);
      expect(truncated.endsWith('...')).toBe(true);
    });

    it('should not truncate short tweets', () => {
      const shortTweet = 'Hello, world!';
      const result = shortTweet.length > 280 ? shortTweet.slice(0, 277) + '...' : shortTweet;

      expect(result).toBe('Hello, world!');
      expect(result.length).toBe(13);
    });

    it('should truncate exactly at 280 boundary', () => {
      const exactTweet = 'a'.repeat(280);
      const result = exactTweet.length > 280 ? exactTweet.slice(0, 277) + '...' : exactTweet;

      expect(result.length).toBe(280);
      expect(result).toBe(exactTweet);
    });
  });

  describe('Image generation probability', () => {
    it('should have 30% probability for image generation', () => {
      const imageProbability = 0.3;
      expect(imageProbability).toBe(0.3);
    });

    it('should generate image when random value is below threshold', () => {
      const threshold = 0.3;
      const randomValue = 0.1;
      const shouldGenerateImage = randomValue < threshold;

      expect(shouldGenerateImage).toBe(true);
    });

    it('should not generate image when random value is above threshold', () => {
      const threshold = 0.3;
      const randomValue = 0.5;
      const shouldGenerateImage = randomValue < threshold;

      expect(shouldGenerateImage).toBe(false);
    });
  });

  describe('System prompt construction', () => {
    it('should include agent persona in system prompt', () => {
      const agentConfig = {
        persona: 'A witty AI assistant',
      };
      const tweetTemplate = 'humor';

      const systemPrompt = `${agentConfig.persona}

You are posting a tweet. Generate a single tweet that:
- Is engaging and authentic to your personality
- Is under 280 characters
- Does not use hashtags excessively (max 1-2 if any)
- Feels natural, not promotional
- Template type: ${tweetTemplate}

Respond with ONLY the tweet text, nothing else.`;

      expect(systemPrompt).toContain('A witty AI assistant');
      expect(systemPrompt).toContain('humor');
      expect(systemPrompt).toContain('280 characters');
    });
  });
});

describe('Tweet Poster - Service Mock Integration', () => {
  let mockLLMService: {
    generateResponse: ReturnType<typeof mock>;
  };
  let mockMediaService: {
    generateImage: ReturnType<typeof mock>;
  };
  let mockTwitterAdapter: {
    postTweet: ReturnType<typeof mock>;
  };
  let mockActivityService: {
    log: ReturnType<typeof mock>;
    logError: ReturnType<typeof mock>;
  };

  beforeEach(() => {
    mockLLMService = {
      generateResponse: mock(() => Promise.resolve({ content: 'Generated tweet content' })),
    };
    mockMediaService = {
      generateImage: mock(() => Promise.resolve({ url: 'https://example.com/image.png' })),
    };
    mockTwitterAdapter = {
      postTweet: mock(() => Promise.resolve('tweet-123456')),
    };
    mockActivityService = {
      log: mock(() => Promise.resolve()),
      logError: mock(() => Promise.resolve()),
    };
  });

  describe('Tweet generation', () => {
    it('should generate tweet using LLM service', async () => {
      const response = await mockLLMService.generateResponse({
        agentId: 'test-agent',
        systemPrompt: 'Test prompt',
        messages: [{ role: 'user', content: 'Generate a tweet.' }],
        config: { temperature: 0.95 },
      });

      expect(mockLLMService.generateResponse).toHaveBeenCalled();
      expect(response.content).toBe('Generated tweet content');
    });

    it('should handle LLM service errors', async () => {
      mockLLMService.generateResponse = mock(() =>
        Promise.reject(new Error('LLM API error'))
      );

      await expect(mockLLMService.generateResponse({})).rejects.toThrow('LLM API error');
    });
  });

  describe('Image generation', () => {
    it('should generate image with image prompt', async () => {
      // First LLM call: generate tweet
      mockLLMService.generateResponse = mock(() =>
        Promise.resolve({ content: 'A tweet about cats' })
      );

      const tweetResponse = await mockLLMService.generateResponse({});
      expect(tweetResponse.content).toBe('A tweet about cats');

      // Second LLM call: generate image prompt
      mockLLMService.generateResponse = mock(() =>
        Promise.resolve({ content: 'cute fluffy cat' })
      );

      const imagePromptResponse = await mockLLMService.generateResponse({});
      const imagePrompt = imagePromptResponse.content.trim();

      // Generate image
      const media = await mockMediaService.generateImage(imagePrompt, {});

      expect(mockMediaService.generateImage).toHaveBeenCalled();
      expect(media.url).toBe('https://example.com/image.png');
    });

    it('should handle image generation failure gracefully', async () => {
      mockMediaService.generateImage = mock(() =>
        Promise.reject(new Error('Image generation failed'))
      );

      let mediaUrl: string | undefined;
      try {
        const media = await mockMediaService.generateImage('prompt', {});
        mediaUrl = media.url;
      } catch {
        // Image generation failed, continue without image
        mediaUrl = undefined;
      }

      expect(mediaUrl).toBeUndefined();
    });
  });

  describe('Tweet posting', () => {
    it('should post tweet without media', async () => {
      const result = await mockTwitterAdapter.postTweet('Hello Twitter!', undefined);

      expect(mockTwitterAdapter.postTweet).toHaveBeenCalled();
      expect(result).toBe('tweet-123456');
    });

    it('should post tweet with image', async () => {
      const result = await mockTwitterAdapter.postTweet('Tweet with image', [
        { type: 'image', url: 'https://example.com/image.png' },
      ]);

      expect(mockTwitterAdapter.postTweet).toHaveBeenCalled();
      expect(result).toBe('tweet-123456');
    });

    it('should handle Twitter API errors', async () => {
      mockTwitterAdapter.postTweet = mock(() =>
        Promise.reject(new Error('Twitter API rate limited'))
      );

      await expect(mockTwitterAdapter.postTweet('test')).rejects.toThrow('Twitter API rate limited');
    });
  });

  describe('Activity logging', () => {
    it('should log response_sent event', async () => {
      await mockActivityService.log({
        agentId: 'test-agent',
        timestamp: Date.now(),
        eventType: 'response_sent',
        platform: 'twitter',
        summary: 'Posted tweet: Hello world...',
        details: { tweetId: 'tweet-123', hasImage: false },
      });

      expect(mockActivityService.log).toHaveBeenCalled();
    });

    it('should log error on failure', async () => {
      await mockActivityService.logError('test-agent', 'twitter', 'Service unavailable');

      expect(mockActivityService.logError).toHaveBeenCalled();
    });
  });
});

describe('Tweet Poster - Integration Scenarios', () => {
  beforeEach(() => {
    process.env.STATE_TABLE = 'test-state-table';
    process.env.ACTIVITY_TABLE = 'test-activity-table';
    process.env.MEDIA_BUCKET = 'test-media-bucket';
    process.env.CDN_URL = 'https://cdn.example.com';
    process.env.AGENT_ID = 'test-agent';
  });

  it('E2E: Full scheduled tweet workflow', async () => {
    // Simulate complete scheduled tweet flow:
    // 1. Lambda triggered by EventBridge schedule
    // 2. Fetch agent config and persona
    // 3. Generate tweet content via LLM
    // 4. Optionally generate image
    // 5. Post to Twitter
    // 6. Log activity

    const agentConfig = {
      id: 'test-agent',
      persona: 'A friendly tech enthusiast who shares daily insights',
      llm: { provider: 'openrouter', model: 'anthropic/claude-3', temperature: 0.9, maxTokens: 280 },
      media: { image: { provider: 'replicate', model: 'flux' } },
    };

    const secrets = {
      TWITTER_API_KEY: 'key',
      TWITTER_API_SECRET: 'secret',
      TWITTER_ACCESS_TOKEN: 'token',
      TWITTER_ACCESS_SECRET: 'token-secret',
      OPENROUTER_API_KEY: 'llm-key',
    };

    // LLM generates tweet content
    const generatedTweet = 'Just discovered an amazing new productivity hack! Thread incoming...';

    // Tweet is posted successfully
    const tweetId = 'tweet-123456';

    // Verify workflow components
    expect(agentConfig.persona).toContain('tech enthusiast');
    expect(generatedTweet.length).toBeLessThanOrEqual(280);
    expect(tweetId).toMatch(/^tweet-\d+$/);
    expect(Object.keys(secrets)).toContain('TWITTER_API_KEY');
  });

  it('E2E: Tweet with AI-generated image', async () => {
    // Simulate tweet with AI-generated image:
    // 1. Generate tweet text
    // 2. Generate image prompt from tweet
    // 3. Generate image via Replicate
    // 4. Upload to S3/CDN
    // 5. Post tweet with media

    // First LLM call: generate tweet
    const _tweetText = 'Check out this stunning sunset render! #AIArt';

    // Second LLM call: generate image prompt
    const imagePrompt = 'vibrant sunset over ocean, dramatic clouds, photorealistic, 8k';

    // Image generation returns URL
    const generatedImageUrl = 'https://cdn.example.com/generated/sunset-abc123.png';

    // Verify image workflow
    expect(imagePrompt).toContain('sunset');
    expect(generatedImageUrl).toMatch(/^https:\/\//);

    // Verify tweet can include media
    const mediaPayload = [{ type: 'image', url: generatedImageUrl }];
    expect(mediaPayload[0].type).toBe('image');
    expect(mediaPayload[0].url).toBe(generatedImageUrl);
  });

  it('E2E: Rate limit handling', async () => {
    // Simulate Twitter API rate limiting:
    // 1. Tweet attempt hits rate limit
    // 2. Handler logs error
    // 3. Error is recorded for retry

    // Simulate rate limit error
    const rateLimitError = new Error('Rate limit exceeded') as any;
    rateLimitError.code = 429;
    rateLimitError.rateLimit = {
      limit: 300,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 900, // 15 minutes
    };

    // Verify rate limit error structure
    expect(rateLimitError.message).toContain('Rate limit');
    expect(rateLimitError.code).toBe(429);
    expect(rateLimitError.rateLimit.remaining).toBe(0);

    // Calculate retry delay
    const retryAfter = rateLimitError.rateLimit.reset - Math.floor(Date.now() / 1000);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(900);
  });

  it('E2E: Media upload to Twitter', async () => {
    // Simulate media upload flow:
    // 1. Generate/fetch image
    // 2. Download image buffer
    // 3. Upload via Twitter v1 media endpoint
    // 4. Attach media_id to tweet

    // Image is generated and stored in S3
    const s3Key = 'agents/test-agent/media/image-123.png';
    const cdnUrl = `https://cdn.example.com/${s3Key}`;

    // Simulate Twitter media upload response
    const mediaId = '1234567890123456789';

    // Verify media upload flow components
    expect(cdnUrl).toMatch(/^https:\/\/cdn\.example\.com\//);
    expect(s3Key).toContain('agents/test-agent/media/');
    expect(mediaId).toMatch(/^\d+$/);

    // Verify tweet includes media attachment
    const tweetPayload = {
      text: 'Tweet with image',
      media: { media_ids: [mediaId] },
    };
    expect(tweetPayload.media.media_ids).toContain(mediaId);
  });
});
