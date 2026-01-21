import { describe, expect, it } from 'vitest';
import { isProbablyPrivateMediaUrl, redactMediaUrlsFromText } from './redact-media-urls.js';

describe('redactMediaUrlsFromText', () => {
  it('redacts CloudFront URLs in text', () => {
    const input = 'See https://d111111abcdef8.cloudfront.net/avatars/a/images/x.png for the image.';
    expect(redactMediaUrlsFromText(input)).toBe('See [media link] for the image.');
  });

  it('leaves non-CloudFront URLs unchanged', () => {
    const input = 'See https://media.example.com/avatars/a/images/x.png for the image.';
    expect(redactMediaUrlsFromText(input)).toBe(input);
  });
});

describe('isProbablyPrivateMediaUrl', () => {
  it('treats CloudFront URLs as private', () => {
    expect(isProbablyPrivateMediaUrl('https://d111111abcdef8.cloudfront.net/avatars/a/images/x.png')).toBe(true);
  });

  it('treats S3 URLs as private', () => {
    expect(isProbablyPrivateMediaUrl('https://bucket.s3.amazonaws.com/avatars/a/images/x.png')).toBe(true);
    expect(isProbablyPrivateMediaUrl('https://s3.amazonaws.com/bucket/avatars/a/images/x.png')).toBe(true);
    expect(isProbablyPrivateMediaUrl('https://bucket.s3.us-east-1.amazonaws.com/avatars/a/images/x.png')).toBe(true);
  });

  it('treats normal HTTPS URLs as public', () => {
    expect(isProbablyPrivateMediaUrl('https://media.example.com/avatars/a/images/x.png')).toBe(false);
  });
});
