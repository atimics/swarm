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

  it('extracts label from markdown links with CloudFront URLs', () => {
    const input = 'You can [Listen to Threshold here](https://d111111abcdef8.cloudfront.net/avatars/a/audio/voice.ogg)';
    expect(redactMediaUrlsFromText(input)).toBe('You can Listen to Threshold here');
  });

  it('handles multiple markdown links with CloudFront URLs', () => {
    const input = '[Link 1](https://d111.cloudfront.net/a.png) and [Link 2](https://d222.cloudfront.net/b.png)';
    expect(redactMediaUrlsFromText(input)).toBe('Link 1 and Link 2');
  });

  it('leaves markdown links with public URLs unchanged', () => {
    const input = 'Check out [this link](https://example.com/page)';
    expect(redactMediaUrlsFromText(input)).toBe(input);
  });

  it('handles mixed markdown and raw URLs', () => {
    const input = '[Click here](https://d111.cloudfront.net/x.png) or visit https://d222.cloudfront.net/y.png';
    expect(redactMediaUrlsFromText(input)).toBe('Click here or visit [media link]');
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
