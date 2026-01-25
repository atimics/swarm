import { describe, it, expect } from 'bun:test';
import { Jimp } from 'jimp';
import {
  ensureTwitterImageWithinLimit,
  TWITTER_MAX_IMAGE_BYTES,
} from './twitter-media.js';

describe('twitter-media', () => {
  it('returns input unchanged when already under limit', async () => {
    const buf = Buffer.from('not-an-image-but-under-limit');
    const res = await ensureTwitterImageWithinLimit(buf, 'image/png');
    expect(res.buffer).toBe(buf);
    expect(res.mimeType).toBe('image/png');
  });

  it('throws for oversized GIFs (avoid silently stripping animation)', async () => {
    const huge = Buffer.alloc(TWITTER_MAX_IMAGE_BYTES + 1);
    await expect(ensureTwitterImageWithinLimit(huge, 'image/gif')).rejects.toThrow(/GIF too large/i);
  });

  it('downsizes oversized PNGs to <= 5MB by re-encoding to JPEG', async () => {
    let size = 1024;
    let png: Buffer | null = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      const image = new Jimp({ width: size, height: size, color: 0xffffffff });
      const data = image.bitmap.data;

      for (let i = 0; i < data.length; i += 4) {
        const v = (i * 1103515245 + 12345) >>> 24;
        data[i] = v;
        data[i + 1] = v ^ 0x55;
        data[i + 2] = v ^ 0xaa;
        data[i + 3] = 0xff;
      }

      png = await image.getBuffer('image/png');
      if (png.length > TWITTER_MAX_IMAGE_BYTES) break;
      size = Math.floor(size * 1.35);
    }

    expect(png).not.toBeNull();
    if (!png) throw new Error('Failed to generate PNG');

    expect(png.length).toBeGreaterThan(TWITTER_MAX_IMAGE_BYTES);

    const out = await ensureTwitterImageWithinLimit(png, 'image/png');
    expect(out.buffer.length).toBeLessThanOrEqual(TWITTER_MAX_IMAGE_BYTES);
    expect(out.mimeType).toBe('image/jpeg');
  }, 30_000);
});
