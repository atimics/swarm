import { describe, it, expect, vi } from 'vitest';
import { copyTextToClipboard } from './clipboard.js';

describe('copyTextToClipboard', () => {
  it('writes text to provided clipboard', async () => {
    const writeText = vi.fn(async () => undefined);

    await copyTextToClipboard('hello', { writeText });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('throws when clipboard is unavailable', async () => {
    await expect(copyTextToClipboard('hello', null)).rejects.toThrow('Clipboard not available');
  });
});
