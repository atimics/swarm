import { describe, it, expect } from 'bun:test';
import { isTwitterFeatureEnabled } from './twitter-feature-flags.js';

describe('isTwitterFeatureEnabled', () => {
  it('defaults mention_replies to enabled when features missing', () => {
    expect(isTwitterFeatureEnabled(undefined, 'mention_replies')).toBe(true);
    expect(isTwitterFeatureEnabled(null, 'mention_replies')).toBe(true);
  });

  it('treats explicit arrays as authoritative', () => {
    expect(isTwitterFeatureEnabled([], 'mention_replies')).toBe(false);
    expect(isTwitterFeatureEnabled(['scheduled_tweets'], 'mention_replies')).toBe(false);
    expect(isTwitterFeatureEnabled(['mention_replies'], 'mention_replies')).toBe(true);
  });

  it('defaults scheduled_tweets to enabled when features missing', () => {
    expect(isTwitterFeatureEnabled(undefined, 'scheduled_tweets')).toBe(true);
  });
});
