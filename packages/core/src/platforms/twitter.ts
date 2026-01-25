/**
 * Twitter/X Platform Adapter
 * Handles Twitter API v2 for posting, mentions, and DMs
 */
import { TwitterApi, TweetV2, UserV2 } from 'twitter-api-v2';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { PlatformAdapter } from './base.js';
import { ensureTwitterImageWithinLimit, TWITTER_MAX_IMAGE_BYTES } from './twitter-media.js';
import type {
  AvatarConfig,
  SwarmEnvelope,
  ResponseAction,
  SenderInfo,
  MessageContent,
  TwitterConfig,
} from '../types/index.js';

export interface TwitterCredentials {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
}

export class TwitterAdapter extends PlatformAdapter {
  readonly platform = 'twitter' as const;
  private client: TwitterApi | null = null;
  private config: TwitterConfig;
  private botUserId: string | null = null;

  constructor(
    avatarConfig: AvatarConfig,
    private readonly credentials: TwitterCredentials,
    injectedClient?: TwitterApi
  ) {
    super(avatarConfig);
    this.config = avatarConfig.platforms.twitter!;

    if (injectedClient) {
      this.client = injectedClient;
    } else if (this.isConfigured()) {
      this.client = new TwitterApi({
        appKey: credentials.appKey,
        appSecret: credentials.appSecret,
        accessToken: credentials.accessToken,
        accessSecret: credentials.accessSecret,
      });
    }
  }

  isConfigured(): boolean {
    return !!(
      this.config?.enabled &&
      this.credentials.appKey &&
      this.credentials.appSecret &&
      this.credentials.accessToken &&
      this.credentials.accessSecret
    );
  }

  getDisplayName(): string {
    return `Twitter @${this.config.username}`;
  }

  async verifyRequest(_body: Buffer, _headers: Record<string, string>): Promise<boolean> {
    // Twitter uses CRC token verification for webhooks
    // For Account Activity API, implement CRC validation
    // For polling-based approach, this isn't used
    return true;
  }

  /**
   * Parse a tweet into SwarmEnvelope
   * Used when processing mentions or timeline tweets
   */
  async parseMessage(body: unknown): Promise<SwarmEnvelope | null> {
    const tweet = body as TweetV2 & { 
      author?: UserV2;
      author_id?: string;
    };
    
    if (!tweet.id || !tweet.text) {
      return null;
    }

    const sender = await this.extractSender(tweet);
    const content = this.extractContent(tweet);
    const mentions = this.extractMentions(tweet);

    const envelope = this.createBaseEnvelope({
      messageId: tweet.id,
      conversationId: tweet.conversation_id || tweet.id,
      timestamp: tweet.created_at ? new Date(tweet.created_at).getTime() : Date.now(),
      sender,
      content,
      raw: tweet,
    });

    envelope.mentions = mentions;
    envelope.replyTo = tweet.referenced_tweets?.find(r => r.type === 'replied_to')?.id;

    return envelope;
  }

  async executeAction(
    action: ResponseAction,
    _conversationId: string,
    replyToMessageId?: string
  ): Promise<boolean> {
    if (!this.client) {
      throw new Error('Twitter client not initialized');
    }

    try {
      switch (action.type) {
        case 'send_message':
          await this.postTweet(action.text, action.media, replyToMessageId);
          break;

        case 'send_voice': {
          const text = action.caption ? `${action.caption} ${action.url}` : action.url;
          await this.postTweet(text, undefined, replyToMessageId);
          break;
        }

        case 'react':
          // Twitter "reaction" is a like
          await this.client.v2.like(await this.getBotUserId(), action.messageId);
          break;

        case 'wait':
          await new Promise(resolve => setTimeout(resolve, action.durationMs));
          break;

        case 'ignore':
          // No action needed
          break;

        default:
          console.warn(`Unknown action type: ${(action as ResponseAction).type}`);
      }
      
      return true;
    } catch (error) {
      console.error('Failed to execute Twitter action:', error);
      return false;
    }
  }

  async sendTypingIndicator(_conversationId: string): Promise<void> {
    // Twitter doesn't have typing indicators for tweets
    // Could be implemented for DMs
  }

  /**
   * Upload media to Twitter and return media IDs
   * Reusable method for both regular tweets and community posts
   */
  async uploadMedia(media: Array<{ type: string; url: string }>): Promise<string[]> {
    if (!this.client) {
      throw new Error('Twitter client not initialized');
    }

    const mediaIds: string[] = [];

    for (const item of media.slice(0, 4)) { // Twitter allows max 4 media items
      try {
        console.log('[TwitterAdapter.uploadMedia] Processing media:', { url: item.url, type: item.type });

        // Download the media (prefer S3 if URL points to our bucket) and upload to Twitter.
        const { buffer, contentType, source } = await downloadMedia(item.url);
        console.log('[TwitterAdapter.uploadMedia] Downloaded:', {
          source,
          bufferSize: buffer.length,
          contentType
        });

        // Detect MIME type from Content-Type header or URL.
        let mimeType = 'image/png';
        if (item.type === 'video') {
          mimeType = 'video/mp4';
        } else {
          if (contentType && !['application/octet-stream', 'binary/octet-stream'].includes(contentType)) {
            mimeType = contentType.split(';')[0];
          } else {
            // Infer from URL extension
            const urlLower = item.url.toLowerCase();
            if (urlLower.includes('.webp')) mimeType = 'image/webp';
            else if (urlLower.includes('.jpg') || urlLower.includes('.jpeg')) mimeType = 'image/jpeg';
            else if (urlLower.includes('.gif')) mimeType = 'image/gif';
          }
        }

        let uploadBuffer = buffer;
        if (mimeType.startsWith('image/') && uploadBuffer.length > TWITTER_MAX_IMAGE_BYTES) {
          const resized = await ensureTwitterImageWithinLimit(uploadBuffer, mimeType);
          uploadBuffer = resized.buffer;
          mimeType = resized.mimeType;
          console.log('[TwitterAdapter.uploadMedia] Downsized image for Twitter upload', {
            originalBytes: buffer.length,
            uploadBytes: uploadBuffer.length,
            mimeType,
          });
        }

        console.log('[TwitterAdapter.uploadMedia] Uploading to Twitter with mimeType:', mimeType);
        const mediaId = await this.client.v1.uploadMedia(uploadBuffer, {
          mimeType: mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'video/mp4',
        });

        console.log('[TwitterAdapter.uploadMedia] Success, mediaId:', mediaId);
        mediaIds.push(mediaId);
      } catch (error) {
        console.error('[TwitterAdapter.uploadMedia] Failed:', {
          url: item.url,
          error: error instanceof Error ? error.message : error,
          stack: error instanceof Error ? error.stack : undefined
        });
      }
    }

    if (mediaIds.length < media.length) {
      console.warn(`[TwitterAdapter.uploadMedia] Only ${mediaIds.length}/${media.length} media items uploaded successfully`);
    }

    return mediaIds;
  }

  /**
   * Post a tweet with optional media
   */
  async postTweet(
    text: string,
    media?: Array<{ type: string; url: string }>,
    replyToTweetId?: string
  ): Promise<string> {
    if (!this.client) {
      throw new Error('Twitter client not initialized');
    }

    const tweetParams: Parameters<TwitterApi['v2']['tweet']>[0] = {
      text,
    };

    // Handle reply
    if (replyToTweetId) {
      tweetParams.reply = {
        in_reply_to_tweet_id: replyToTweetId,
      };
    }

    // Handle media upload using the reusable method
    if (media && media.length > 0) {
      const mediaIds = await this.uploadMedia(media);
      if (mediaIds.length > 0) {
        tweetParams.media = { media_ids: mediaIds as [string] };
      }
    }

    const result = await this.client.v2.tweet(tweetParams);
    return result.data.id;
  }

  /**
   * Post a tweet to a Twitter Community
   * Note: Community posting requires specific API access tier.
   */
  async postToCommunity(
    communityId: string,
    text: string,
    media?: Array<{ type: string; url: string }>,
    replyToTweetId?: string
  ): Promise<string> {
    if (!this.client) {
      throw new Error('Twitter client not initialized');
    }

    const tweetParams: Parameters<TwitterApi['v2']['tweet']>[0] = {
      text,
    };

    // Community posts are supported via community_id (may require elevated access tier).
    (tweetParams as { community_id?: string }).community_id = communityId;

    // Handle reply within community
    if (replyToTweetId) {
      tweetParams.reply = {
        in_reply_to_tweet_id: replyToTweetId,
      };
    }

    // Handle media upload
    if (media && media.length > 0) {
      const mediaIds = await this.uploadMedia(media);
      if (mediaIds.length > 0) {
        tweetParams.media = { media_ids: mediaIds as [string] };
      }
    }

    const result = await this.client.v2.tweet(tweetParams);
    return result.data.id;
  }

  /**
   * Get recent tweets from a community timeline
   * Note: This is a placeholder - community timeline access varies by API tier
   */
  async getCommunityTimeline(
    _communityId: string,
    _sinceId?: string,
    _maxResults: number = 20
  ): Promise<SwarmEnvelope[]> {
    // Community timeline access requires specific API permissions
    // This is a placeholder for future implementation when API access is available
    // Possible approaches:
    // 1. Use search API with community filter (if available)
    // 2. Use community-specific endpoints (Enterprise tier)
    // 3. Scrape community page (not recommended for production)
    console.warn('getCommunityTimeline is not yet implemented - requires elevated API access');
    return [];
  }

  /**
   * Get recent mentions of the bot
   */
  async getMentions(
    sinceId?: string,
    options?: { maxResults?: number }
  ): Promise<SwarmEnvelope[]> {
    if (!this.client) {
      throw new Error('Twitter client not initialized');
    }

    const userId = await this.getBotUserId();
    // Twitter API allows max_results between 5 and 100
    const maxResults = Math.min(100, Math.max(5, options?.maxResults || 20));

    const mentions = await this.client.v2.userMentionTimeline(userId, {
      since_id: sinceId,
      max_results: maxResults,
      expansions: ['author_id', 'referenced_tweets.id'],
      'tweet.fields': ['created_at', 'conversation_id', 'in_reply_to_user_id'],
      'user.fields': ['username', 'name'],
    });

    const envelopes: SwarmEnvelope[] = [];
    
    for (const tweet of mentions.data.data || []) {
      const author = mentions.includes?.users?.find(u => u.id === tweet.author_id);
      const envelope = await this.parseMessage({ ...tweet, author });
      if (envelope) {
        envelopes.push(envelope);
      }
    }

    return envelopes;
  }

  /**
   * Quote tweet with optional image
   */
  async quoteTweet(
    text: string,
    quoteTweetId: string,
    media?: Array<{ type: string; url: string }>
  ): Promise<string> {
    if (!this.client) {
      throw new Error('Twitter client not initialized');
    }

    const tweetParams: Parameters<TwitterApi['v2']['tweet']>[0] = {
      text,
      quote_tweet_id: quoteTweetId,
    };

    // Handle media upload using the reusable method
    if (media && media.length > 0) {
      const mediaIds = await this.uploadMedia(media);
      if (mediaIds.length > 0) {
        tweetParams.media = { media_ids: mediaIds as [string] };
      }
    }

    const result = await this.client.v2.tweet(tweetParams);
    return result.data.id;
  }

  /**
   * Get the bot's Twitter user ID (cached after first call)
   */
  async getBotUserId(): Promise<string> {
    if (this.botUserId) {
      return this.botUserId;
    }

    if (!this.client) {
      throw new Error('Twitter client not initialized');
    }

    const me = await this.client.v2.me();
    this.botUserId = me.data.id;
    return this.botUserId;
  }

  /**
   * Get the bot's Twitter username from config
   */
  getBotUsername(): string | undefined {
    return this.config.username;
  }

  /**
   * Extract sender info from tweet
   */
  private async extractSender(tweet: TweetV2 & { author?: UserV2; author_id?: string }): Promise<SenderInfo> {
    const author = tweet.author;
    
    return {
      id: tweet.author_id || author?.id || 'unknown',
      username: author?.username,
      displayName: author?.name,
      isBot: false, // Twitter doesn't expose bot status easily
      platform: 'twitter',
      platformUserId: tweet.author_id || author?.id || 'unknown',
    };
  }

  /**
   * Extract content from tweet
   */
  private extractContent(tweet: TweetV2): MessageContent {
    return {
      text: tweet.text,
      // Note: Media extraction requires additional API calls with expansions
    };
  }

  /**
   * Extract mentions from tweet
   */
  private extractMentions(tweet: TweetV2): SwarmEnvelope['mentions'] {
    const mentions: SwarmEnvelope['mentions'] = [];
    
    // Extract @mentions from tweet text using regex
    const mentionRegex = /@(\w+)/g;
    let match;
    
    while ((match = mentionRegex.exec(tweet.text)) !== null) {
      mentions.push({
        userId: match[1], // We only have username, not ID
        username: match[1],
        offset: match.index,
        length: match[0].length,
      });
    }

    return mentions;
  }

  /**
   * Get the underlying TwitterApi client for advanced usage
   */
  getClient(): TwitterApi | null {
    return this.client;
  }
}

const s3Client = new S3Client({});

async function downloadMedia(url: string): Promise<{ buffer: Buffer; contentType?: string; source: 's3' | 'http' }> {
  const cdnUrlEnv = process.env.CDN_URL;
  const mediaBucketEnv = process.env.MEDIA_BUCKET;

  console.log('[TwitterAdapter.downloadMedia] Starting download:', {
    url,
    CDN_URL: cdnUrlEnv || '(not set)',
    MEDIA_BUCKET: mediaBucketEnv || '(not set)'
  });

  const s3Location = resolveS3Location(url);

  if (s3Location) {
    console.log('[TwitterAdapter.downloadMedia] Resolved S3 location:', s3Location);
    try {
      const response = await s3Client.send(new GetObjectCommand({
        Bucket: s3Location.bucket,
        Key: s3Location.key,
      }));

      if (!response.Body) {
        throw new Error('Empty S3 response body');
      }

      const buffer = await streamToBuffer(response.Body as Readable);
      console.log('[TwitterAdapter.downloadMedia] S3 fetch successful:', {
        bucket: s3Location.bucket,
        key: s3Location.key,
        size: buffer.length,
        contentType: response.ContentType
      });
      return { buffer, contentType: response.ContentType, source: 's3' };
    } catch (error) {
      console.error('[TwitterAdapter.downloadMedia] S3 fetch failed, falling back to HTTP:', {
        bucket: s3Location.bucket,
        key: s3Location.key,
        error: error instanceof Error ? error.message : error
      });
    }
  } else {
    console.log('[TwitterAdapter.downloadMedia] Could not resolve S3 location, using HTTP fetch');
  }

  console.log('[TwitterAdapter.downloadMedia] Fetching via HTTP:', url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP fetch failed: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers?.get?.('content-type') ?? undefined;

  console.log('[TwitterAdapter.downloadMedia] HTTP fetch successful:', {
    size: buffer.length,
    contentType
  });

  return { buffer, contentType, source: 'http' };
}

function resolveS3Location(url: string): { bucket: string; key: string } | null {
  const bucketFromEnv = process.env.MEDIA_BUCKET;
  const cdnUrl = normalizeUrlPrefix(process.env.CDN_URL);
  if (cdnUrl && url.startsWith(cdnUrl) && bucketFromEnv) {
    const key = decodeURIComponent(url.slice(cdnUrl.length).replace(/^\/+/, ''));
    if (key) {
      return { bucket: bucketFromEnv, key };
    }
  }

  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const path = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));

    const virtualHostMatch = host.match(/^(.+)\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/);
    if (virtualHostMatch?.[1]) {
      return { bucket: virtualHostMatch[1], key: path };
    }

    if (host === 's3.amazonaws.com' || host.startsWith('s3.') || host.startsWith('s3-')) {
      const [bucket, ...rest] = path.split('/');
      if (bucket && rest.length > 0) {
        return { bucket, key: rest.join('/') };
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function normalizeUrlPrefix(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}
