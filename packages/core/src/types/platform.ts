/**
 * Platform and agent configuration types
 *
 * Re-exported from the canonical definitions in ./index.ts.
 * This module exists so sibling type files (envelope.ts, response.ts,
 * service.ts, state.ts) can import platform-related types without
 * pulling in the entire barrel.
 */
export type {
  Platform,
  AvatarConfig,
  PlatformConfigs,
  TelegramUserRef,
  TelegramChatRef,
  TelegramConfig,
  DiscordConfig,
  TwitterCommunityConfig,
  AutonomousPostsConfig,
  TwitterConfig,
  WebConfig,
  LLMConfig,
  VoiceConfig,
  MediaConfig,
  SchedulingConfig,
  ScheduledTweet,
  BehaviorConfig,
  SolanaConfig,
  SolanaFeature,
} from './index.js';
