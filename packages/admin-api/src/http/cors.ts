import type { APIGatewayProxyEventV2 } from 'aws-lambda';

function getHeader(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const direct = event.headers?.[name];
  if (direct) return direct;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers || {})) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function parseAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return [];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

export interface CorsOptions {
  allowCredentials?: boolean;
  allowMethods?: string;
  allowHeaders?: string;
}

export function getCorsHeaders(
  event: APIGatewayProxyEventV2,
  options: CorsOptions = {}
): Record<string, string> {
  const origin = getHeader(event, 'origin') || '';
  const allowedOrigins = parseAllowedOrigins();

  // If no origins configured, don't emit CORS headers.
  // This keeps same-origin /api proxy simple while allowing opt-in for local dev.
  if (allowedOrigins.length === 0) {
    return {};
  }

  const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  const allowCredentials = options.allowCredentials ?? true;
  const allowMethods = options.allowMethods ?? 'GET, POST, PUT, DELETE, OPTIONS';
  const allowHeaders =
    options.allowHeaders ??
    'Content-Type, Authorization, CF-Access-JWT-Assertion, Prefer, Idempotency-Key, x-internal-test-key';

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Credentials': allowCredentials ? 'true' : 'false',
    'Access-Control-Allow-Methods': allowMethods,
    'Access-Control-Allow-Headers': allowHeaders,
    // Important when reflecting specific origins.
    'Vary': 'Origin',
  };
}
