export function redactMediaUrlsFromText(text: string): string {
  if (!text) return text;

  // Redact raw CloudFront URLs from user-visible or model-facing text. These links
  // are often not directly accessible outside the app flow (e.g., missing object,
  // delayed upload, or protected origin), and the model tends to echo them.
  const cloudfrontUrlPattern = /\bhttps?:\/\/[^\s<>()"']*cloudfront\.net[^\s<>()"']*/gi;
  return text.replace(cloudfrontUrlPattern, '[media link]');
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
