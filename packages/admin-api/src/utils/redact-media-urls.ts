export function redactMediaUrlsFromText(text: string): string {
  if (!text) return text;

  // Pattern for CloudFront/S3 URLs
  const privateUrlPattern = /https?:\/\/[^\s<>()"'\]]*(?:cloudfront\.net|s3[^/]*\.amazonaws\.com)[^\s<>()"'\]]*/gi;

  // First, handle markdown links containing private URLs: [text](url) -> text
  // This preserves the link label text instead of breaking the markdown syntax
  const markdownLinkPattern = /\[([^\]]+)\]\((https?:\/\/[^\s<>()"']*(?:cloudfront\.net|s3[^/]*\.amazonaws\.com)[^\s<>()"')]*)\)/gi;
  let result = text.replace(markdownLinkPattern, '$1');

  // Then redact any remaining raw CloudFront/S3 URLs
  result = result.replace(privateUrlPattern, '[media link]');

  return result;
}

export function isProbablyPrivateMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    if (host.endsWith('cloudfront.net')) return true;

    // S3 virtual-hosted-style or path-style URLs are rarely accessible to models/users.
    if (host === 's3.amazonaws.com') return true;
    if (host.endsWith('.s3.amazonaws.com')) return true;
    if (host.includes('.s3.') && host.endsWith('.amazonaws.com')) return true;

    return false;
  } catch {
    return false;
  }
}
