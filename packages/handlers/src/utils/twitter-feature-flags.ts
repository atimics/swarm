export type TwitterFeature =
  | 'scheduled_tweets'
  | 'mention_replies'
  | 'dm_responses'
  | 'autonomous_posts'
  | 'community_posts';

const DEFAULT_TWITTER_FEATURES: readonly TwitterFeature[] = ['scheduled_tweets', 'mention_replies'];

export function isTwitterFeatureEnabled(
  features: unknown,
  feature: TwitterFeature
): boolean {
  // Back-compat: older configs may omit `features` entirely.
  // Treat missing/non-array as defaults, but treat an explicit array (even empty) as authoritative.
  if (!Array.isArray(features)) {
    return DEFAULT_TWITTER_FEATURES.includes(feature);
  }

  return (features as unknown[]).includes(feature);
}
