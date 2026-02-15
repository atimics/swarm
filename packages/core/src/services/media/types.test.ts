import { describe, it, expect } from 'vitest';
import { DEFAULT_MODELS } from './types.js';

describe('core media DEFAULT_MODELS', () => {
  it('defaults image_generation to Nano Banana Pro', () => {
    expect(DEFAULT_MODELS.image_generation).toBe('google/nano-banana-pro');
  });
});
