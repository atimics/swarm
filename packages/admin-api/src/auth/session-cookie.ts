import type { APIGatewayProxyEventV2 } from 'aws-lambda';

const COOKIE_NAME = 'swarm_session';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'Lax' as const,
  path: '/',
  maxAgeSeconds: 24 * 60 * 60,
};

function getCookieDomain(): string | undefined {
  const authDomain = process.env.AUTH_DOMAIN;
  if (!authDomain) return undefined;

  const parts = authDomain.split('.').filter(Boolean);
  if (parts.length >= 2) {
    return '.' + parts.slice(-2).join('.');
  }

  return undefined;
}

function buildCookie(params: {
  value: string;
  maxAgeSeconds: number;
  domain?: string;
}): string {
  const parts = [
    `${COOKIE_NAME}=${params.value}`,
    'HttpOnly',
    'Secure',
    `SameSite=${COOKIE_OPTIONS.sameSite}`,
    `Path=${COOKIE_OPTIONS.path}`,
    `Max-Age=${params.maxAgeSeconds}`,
  ];

  if (params.domain) {
    parts.push(`Domain=${params.domain}`);
  }

  return parts.join('; ');
}

/**
 * Read the swarm session token from the Cookie header.
 *
 * Note: If duplicates exist (host-only + Domain cookies), the order is not
 * guaranteed. We attempt to choose the first non-empty value; the codebase
 * should avoid duplicates by clearing the alternate scope when setting.
 */
export function getSessionFromCookie(event: APIGatewayProxyEventV2): string | null {
  const cookies = event.cookies || [];
  for (const cookie of cookies) {
    const [name, value] = cookie.split('=');
    if (name === COOKIE_NAME && value) return value;
  }
  return null;
}

/**
 * Set the session cookie.
 *
 * If AUTH_DOMAIN implies a parent-domain cookie, we also clear any existing
 * host-only cookie to avoid duplicate swarm_session values being sent.
 */
export function getSetSessionCookies(sessionToken: string): string[] {
  const domain = getCookieDomain();

  if (!domain) {
    return [buildCookie({ value: sessionToken, maxAgeSeconds: COOKIE_OPTIONS.maxAgeSeconds })];
  }

  return [
    // Preferred: parent-domain cookie shared across subdomains.
    buildCookie({ value: sessionToken, maxAgeSeconds: COOKIE_OPTIONS.maxAgeSeconds, domain }),
    // Cleanup: clear host-only cookie to prevent duplicates.
    buildCookie({ value: '', maxAgeSeconds: 0 }),
  ];
}

/**
 * Clear the session cookie.
 *
 * Clears both host-only and parent-domain variants (if applicable).
 */
export function getClearSessionCookies(): string[] {
  const domain = getCookieDomain();

  if (!domain) {
    return [buildCookie({ value: '', maxAgeSeconds: 0 })];
  }

  return [
    buildCookie({ value: '', maxAgeSeconds: 0 }),
    buildCookie({ value: '', maxAgeSeconds: 0, domain }),
  ];
}
