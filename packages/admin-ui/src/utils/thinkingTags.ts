export interface ThinkingExtractionResult {
  cleanContent: string;
  thinkingBlocks: string[];
}

export function extractThinkingTags(content: string): ThinkingExtractionResult {
  if (!content) return { cleanContent: '', thinkingBlocks: [] };

  const thinkingBlocks: string[] = [];

  const thinkingRegex = /<\s*thinking\s*>([\s\S]*?)<\s*\/\s*thinking\s*>/gi;
  const thinkingOrphanOpenRegex = /<\s*thinking\s*>/gi;
  const thinkingOrphanCloseRegex = /<\s*\/\s*thinking\s*>/gi;
  const thinkingSelfClosingRegex = /<\s*thinking\s*\/\s*>/gi;

  let match: RegExpExecArray | null;
  while ((match = thinkingRegex.exec(content)) !== null) {
    const block = (match[1] ?? '').trim();
    if (block) thinkingBlocks.push(block);
  }

  let cleanContent = content.replace(thinkingRegex, '').trim();
  cleanContent = cleanContent
    .replace(thinkingSelfClosingRegex, '')
    .replace(thinkingOrphanOpenRegex, '')
    .replace(thinkingOrphanCloseRegex, '')
    .trim();

  cleanContent = cleanContent.replace(/\n\s*\n\s*\n/g, '\n\n').trim();

  return { cleanContent, thinkingBlocks };
}
