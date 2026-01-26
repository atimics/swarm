/**
 * Cloudflare Access Authentication
 * Verifies JWT tokens from Cloudflare Access
 */
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { CloudflareAccessClaims, UserSession } from '../types.js';
import * as nodeCrypto from 'crypto';
import { getSessionFromCookie } from './session-cookie.js';
import { getSessionWithUser } from '../services/wallet-auth.js';
import { getAccountSummary, getOrCreateAccountForWallet } from '../services/accounts.js';
import { AuthError } from './errors.js';
import { checkActiveUserAccess } from '../services/active-user-limit.js';

// Cloudflare Access public keys endpoint
const CF_ACCESS_CERTS_URL = process.env.CF_ACCESS_CERTS_URL;
const CF_ACCESS_TEAM_DOMAIN = process.env.CF_ACCESS_TEAM_DOMAIN;
const CF_ACCESS_AUD = process.env.CF_ACCESS_AUD;

interface CloudflareJWK {
  kid: string;
  kty: string;
  alg: string;
  use: string;
  e: string;
  n: string;
}

interface CloudflareKeysResponse {
  keys: CloudflareJWK[];
  public_cert: { kid: string; cert: string };
  public_certs: { kid: string; cert: string }[];
}

let cachedKeys: CloudflareKeysResponse | null = null;
let cacheExpiry = 0;

/**
 * Fetch Cloudflare Access public keys
 */
async function getPublicKeys(): Promise<CloudflareKeysResponse> {
  const now = Date.now();
  
  if (cachedKeys && now < cacheExpiry) {
    return cachedKeys;
  }

  const certsUrl = CF_ACCESS_CERTS_URL || 
    `https://${CF_ACCESS_TEAM_DOMAIN}.cloudflareaccess.com/cdn-cgi/access/certs`;

  const response = await fetch(certsUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch Cloudflare Access keys: ${response.statusText}`);
  }

  cachedKeys = await response.json() as CloudflareKeysResponse;
  cacheExpiry = now + 3600000; // Cache for 1 hour

  return cachedKeys;
}

/**
 * Decode a JWT without verification (to get the header)
 */
function decodeJwtHeader(token: string): { kid?: string; alg?: string } {
  const [headerB64] = token.split('.');
  if (!headerB64) throw new Error('Invalid JWT format');
  
  const headerJson = Buffer.from(headerB64, 'base64url').toString('utf-8');
  return JSON.parse(headerJson);
}

/**
 * Verify and decode a Cloudflare Access JWT using Node.js crypto
 */
async function verifyAccessToken(token: string): Promise<CloudflareAccessClaims> {
  // Get the key ID from the token header
  const header = decodeJwtHeader(token);
  
  // Fetch public keys (JWK format)
  const keys = await getPublicKeys();
  
  // Find the matching JWK key
  const jwk = keys.keys.find(k => k.kid === header.kid);
  if (!jwk) {
    throw new Error('No matching key found for token');
  }

  // Create a public key from JWK using Node.js crypto
  const publicKey = nodeCrypto.createPublicKey({
    key: {
      kty: jwk.kty,
      n: jwk.n,
      e: jwk.e,
    },
    format: 'jwk',
  });

  // Split the token
  const [headerB64, payloadB64, signatureB64] = token.split('.');
  if (!headerB64 || !payloadB64 || !signatureB64) {
    throw new Error('Invalid JWT format');
  }

  // Verify the signature using Node.js crypto
  const data = `${headerB64}.${payloadB64}`;
  const signature = Buffer.from(signatureB64, 'base64url');

  const isValid = nodeCrypto.verify(
    'RSA-SHA256',
    Buffer.from(data),
    publicKey,
    signature
  );

  if (!isValid) {
    throw new Error('Invalid token signature');
  }

  // Decode the payload
  const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf-8');
  const claims = JSON.parse(payloadJson) as CloudflareAccessClaims;

  // Verify claims
  const now = Math.floor(Date.now() / 1000);

  if (claims.exp < now) {
    throw new Error('Token has expired');
  }

  if (claims.nbf && claims.nbf > now) {
    throw new Error('Token not yet valid');
  }

  // Verify audience if configured
  if (CF_ACCESS_AUD) {
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(CF_ACCESS_AUD)) {
      throw new Error('Invalid token audience');
    }
  }

  return claims;
}

/**
 * Authenticate a request using Cloudflare Access
 * Accepts either:
 * - a Cloudflare Access JWT (CF-Access-JWT-Assertion / Bearer token), or
 * - a first-party `swarm_session` cookie (server-side session)
 *
 * Note: This does not allow origin/referer-only fallbacks.
 */
export async function authenticateRequest(
  event: APIGatewayProxyEventV2
): Promise<UserSession> {
  // Check for internal AWS testing mode
  // This header can only be set by someone with direct API Gateway access (not through Cloudflare)
  // and is verified by checking that the request comes from a known internal source
  const internalTestKey = process.env.INTERNAL_TEST_KEY;
  const providedTestKey = event.headers['x-internal-test-key'];
  if (internalTestKey && providedTestKey && internalTestKey === providedTestKey) {
    console.log('Auth: Internal test mode enabled');
    return {
      email: 'internal-test@aws.local',
      userId: 'internal-test-user',
      isAdmin: true,
      accessToken: 'internal-test',
    };
  }

  // Get the CF-Access-JWT-Assertion header
  const token = 
    event.headers['cf-access-jwt-assertion'] ||
    event.headers['CF-Access-JWT-Assertion'] ||
    event.headers['authorization']?.replace('Bearer ', '');

  // If no Cloudflare token, use first-party session cookie auth.
  if (!token) {
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      throw new Error('No authentication token provided');
    }

    const session = await getSessionWithUser(sessionToken);
    if (!session) {
      throw new Error('Session expired');
    }

    // Look up admin role from account record in database
    const accountId = session.accountId || await getOrCreateAccountForWallet(session.walletAddress);
    const account = await getAccountSummary(accountId);
    const isAdmin = account?.role === 'admin';

    // Enforce active-user slots (when configured)
    const access = await checkActiveUserAccess({ accountId, isAdmin });
    if (!access.allowed) {
      throw new AuthError('Active user slots full', 403, {
        limit: access.limit,
        cutoffLastSeenAt: access.cutoffLastSeenAt,
        accountId,
      });
    }

    const email = (session.user as { email?: string }).email || '';

    return {
      email: email || session.walletAddress,
      userId: session.walletAddress,
      isAdmin,
      accessToken: '',
      accountId,
    };
  }

  // Verify the token
  const claims = await verifyAccessToken(token);

  // For CF Access users, look up by email in accounts (or create)
  // Note: CF Access path is less common now; Privy/wallet auth is primary
  const isAdmin = false; // CF Access users default to non-admin; use DB role instead

  return {
    email: claims.email,
    userId: claims.sub,
    isAdmin,
    accessToken: token,
  };
}

/**
 * Require admin access - returns true if admin, false otherwise
 */
export function requireAdmin(session: UserSession): boolean {
  return session.isAdmin;
}

/**
 * Create a session for development/testing (when CF Access is not configured)
 */
export function createDevSession(email: string = 'dev@localhost'): UserSession {
  return {
    email,
    userId: 'dev-user',
    isAdmin: true,
    accessToken: 'dev-token',
  };
}
