export interface ClipboardLike {
  writeText: (text: string) => Promise<void>;
}

export async function copyTextToClipboard(text: string, clipboard?: ClipboardLike | null): Promise<void> {
  const resolvedClipboard = clipboard ?? (typeof navigator !== 'undefined' ? navigator.clipboard : undefined);
  if (!resolvedClipboard?.writeText) {
    throw new Error('Clipboard not available');
  }

  await resolvedClipboard.writeText(text);
}
