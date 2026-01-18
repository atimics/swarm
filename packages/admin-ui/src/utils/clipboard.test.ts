import { describe, it, expect, mock } from 'bun:test';
import { copyTextToClipboard } from './clipboard.js';

describe('copyTextToClipboard', () => {
  it('writes text to provided clipboard', async () => {
    const writeText = mock(async () => undefined);

    await copyTextToClipboard('hello', { writeText });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('throws when clipboard is unavailable', async () => {
    await expect(copyTextToClipboard('hello', null)).rejects.toThrow('Clipboard not available');
  });
});
