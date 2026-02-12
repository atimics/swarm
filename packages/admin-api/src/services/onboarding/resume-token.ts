import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'crypto';
import {
  OnboardingResumeTokenError,
  type OnboardingResumeTokenErrorCode,
  type OnboardingContractVersion,
} from './errors.js';
import {
  ONBOARDING_CONTRACT_VERSION,
} from './types.js';

const RESUME_TOKEN_ALGORITHM = 'HS256';
const DEFAULT_RESUME_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

interface ResumeTokenHeader {
  alg: typeof RESUME_TOKEN_ALGORITHM;
  typ: 'JWT';
}

export interface OnboardingResumeTokenClaims {
  v: OnboardingContractVersion;
  avatarId: string;
  runId: string;
  state: string;
  step: string;
  failureSeq: number;
  iat: number;
  exp: number;
  nonce: string;
}

export interface SignOnboardingResumeTokenParams {
  avatarId: string;
  runId: string;
  state: string;
  step: string;
  failureSeq: number;
  ttlMs?: number;
  nonce?: string;
}

export interface SignOnboardingResumeTokenOptions {
  secret: string;
  now?: () => number;
  nonceFactory?: () => string;
}

export interface VerifyOnboardingResumeTokenOptions {
  secret: string;
  now?: () => number;
  expectedAvatarId?: string;
  expectedRunId?: string;
  expectedVersion?: OnboardingContractVersion;
  minFailureSeq?: number;
}

export type VerifyOnboardingResumeTokenResult =
  | {
      valid: true;
      claims: OnboardingResumeTokenClaims;
      tokenHash: string;
    }
  | {
      valid: false;
      error: OnboardingResumeTokenError;
    };

export interface OnboardingResumeTokenHelpers {
  sign: (params: SignOnboardingResumeTokenParams) => {
    token: string;
    claims: OnboardingResumeTokenClaims;
    tokenHash: string;
  };
  verify: (
    token: string,
    options?: Omit<VerifyOnboardingResumeTokenOptions, 'secret' | 'now'>
  ) => VerifyOnboardingResumeTokenResult;
  hash: (token: string) => string;
}

function encodeBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeBase64UrlToUtf8(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function createSignature(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

function signaturesMatch(a: string, b: string): boolean {
  const aBytes = Buffer.from(a, 'utf8');
  const bBytes = Buffer.from(b, 'utf8');

  if (aBytes.length !== bBytes.length) {
    return false;
  }

  return timingSafeEqual(aBytes, bBytes);
}

function makeResumeTokenError(
  errorCode: OnboardingResumeTokenErrorCode,
  message: string
): OnboardingResumeTokenError {
  return new OnboardingResumeTokenError({
    errorCode,
    message,
  });
}

function parseClaims(value: string): OnboardingResumeTokenClaims | null {
  try {
    const parsed = JSON.parse(value) as Partial<OnboardingResumeTokenClaims>;

    if (
      typeof parsed.v !== 'string'
      || typeof parsed.avatarId !== 'string'
      || typeof parsed.runId !== 'string'
      || typeof parsed.state !== 'string'
      || typeof parsed.step !== 'string'
      || typeof parsed.failureSeq !== 'number'
      || typeof parsed.iat !== 'number'
      || typeof parsed.exp !== 'number'
      || typeof parsed.nonce !== 'string'
    ) {
      return null;
    }

    if (
      !Number.isFinite(parsed.failureSeq)
      || !Number.isFinite(parsed.iat)
      || !Number.isFinite(parsed.exp)
      || parsed.failureSeq < 0
    ) {
      return null;
    }

    return {
      v: parsed.v as OnboardingContractVersion,
      avatarId: parsed.avatarId,
      runId: parsed.runId,
      state: parsed.state,
      step: parsed.step,
      failureSeq: Math.floor(parsed.failureSeq),
      iat: Math.floor(parsed.iat),
      exp: Math.floor(parsed.exp),
      nonce: parsed.nonce,
    };
  } catch {
    return null;
  }
}

function validateSecret(secret: string): void {
  if (!secret || secret.trim().length < 16) {
    throw new Error('Resume token secret must be at least 16 characters.');
  }
}

function validateRequiredClaim(value: string, fieldName: string): void {
  if (!value || !value.trim()) {
    throw new Error(`"${fieldName}" is required to issue a resume token.`);
  }
}

export function hashOnboardingResumeToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isOnboardingResumeTokenExpired(
  claims: Pick<OnboardingResumeTokenClaims, 'exp'>,
  nowMs = Date.now()
): boolean {
  return nowMs > claims.exp;
}

export function signOnboardingResumeToken(
  params: SignOnboardingResumeTokenParams,
  options: SignOnboardingResumeTokenOptions
): {
  token: string;
  claims: OnboardingResumeTokenClaims;
  tokenHash: string;
} {
  validateSecret(options.secret);
  validateRequiredClaim(params.avatarId, 'avatarId');
  validateRequiredClaim(params.runId, 'runId');
  validateRequiredClaim(params.state, 'state');
  validateRequiredClaim(params.step, 'step');

  const now = options.now?.() ?? Date.now();
  const ttlMs = typeof params.ttlMs === 'number' && params.ttlMs > 0
    ? Math.floor(params.ttlMs)
    : DEFAULT_RESUME_TOKEN_TTL_MS;

  const claims: OnboardingResumeTokenClaims = {
    v: ONBOARDING_CONTRACT_VERSION,
    avatarId: params.avatarId,
    runId: params.runId,
    state: params.state,
    step: params.step,
    failureSeq: Math.max(0, Math.floor(params.failureSeq)),
    iat: now,
    exp: now + ttlMs,
    nonce: params.nonce ?? options.nonceFactory?.() ?? randomBytes(16).toString('hex'),
  };

  const header: ResumeTokenHeader = {
    alg: RESUME_TOKEN_ALGORITHM,
    typ: 'JWT',
  };

  const headerSegment = encodeBase64UrlJson(header);
  const payloadSegment = encodeBase64UrlJson(claims);
  const signingInput = `${headerSegment}.${payloadSegment}`;
  const signatureSegment = createSignature(signingInput, options.secret);
  const token = `${signingInput}.${signatureSegment}`;

  return {
    token,
    claims,
    tokenHash: hashOnboardingResumeToken(token),
  };
}

export function verifyOnboardingResumeToken(
  token: string,
  options: VerifyOnboardingResumeTokenOptions
): VerifyOnboardingResumeTokenResult {
  validateSecret(options.secret);

  if (!token || !token.trim()) {
    return {
      valid: false,
      error: makeResumeTokenError('resume_token_invalid', 'Missing resume token.'),
    };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return {
      valid: false,
      error: makeResumeTokenError('resume_token_invalid', 'Malformed resume token.'),
    };
  }

  const [headerSegment, payloadSegment, signatureSegment] = parts;
  if (!headerSegment || !payloadSegment || !signatureSegment) {
    return {
      valid: false,
      error: makeResumeTokenError('resume_token_invalid', 'Malformed resume token.'),
    };
  }

  const signingInput = `${headerSegment}.${payloadSegment}`;
  const expectedSignature = createSignature(signingInput, options.secret);
  if (!signaturesMatch(signatureSegment, expectedSignature)) {
    return {
      valid: false,
      error: makeResumeTokenError('resume_token_invalid', 'Resume token signature is invalid.'),
    };
  }

  let header: ResumeTokenHeader | null = null;
  try {
    header = JSON.parse(decodeBase64UrlToUtf8(headerSegment)) as ResumeTokenHeader;
  } catch {
    return {
      valid: false,
      error: makeResumeTokenError('resume_token_invalid', 'Malformed resume token header.'),
    };
  }

  if (!header || header.alg !== RESUME_TOKEN_ALGORITHM || header.typ !== 'JWT') {
    return {
      valid: false,
      error: makeResumeTokenError('resume_token_invalid', 'Unsupported resume token algorithm.'),
    };
  }

  let payloadText: string;
  try {
    payloadText = decodeBase64UrlToUtf8(payloadSegment);
  } catch {
    return {
      valid: false,
      error: makeResumeTokenError('resume_token_invalid', 'Malformed resume token payload.'),
    };
  }

  const claims = parseClaims(payloadText);
  if (!claims) {
    return {
      valid: false,
      error: makeResumeTokenError('resume_token_invalid', 'Malformed resume token payload.'),
    };
  }

  const expectedVersion = options.expectedVersion ?? ONBOARDING_CONTRACT_VERSION;
  if (claims.v !== expectedVersion) {
    return {
      valid: false,
      error: makeResumeTokenError('resume_token_invalid', 'Resume token version mismatch.'),
    };
  }

  if (options.expectedAvatarId && claims.avatarId !== options.expectedAvatarId) {
    return {
      valid: false,
      error: makeResumeTokenError('resume_token_invalid', 'Resume token avatar scope mismatch.'),
    };
  }

  if (options.expectedRunId && claims.runId !== options.expectedRunId) {
    return {
      valid: false,
      error: makeResumeTokenError('resume_token_invalid', 'Resume token run scope mismatch.'),
    };
  }

  const now = options.now?.() ?? Date.now();
  if (isOnboardingResumeTokenExpired(claims, now)) {
    return {
      valid: false,
      error: makeResumeTokenError('resume_token_expired', 'Resume token has expired.'),
    };
  }

  if (
    typeof options.minFailureSeq === 'number'
    && claims.failureSeq < options.minFailureSeq
  ) {
    return {
      valid: false,
      error: makeResumeTokenError('resume_token_replayed', 'Resume token has been superseded.'),
    };
  }

  return {
    valid: true,
    claims,
    tokenHash: hashOnboardingResumeToken(token),
  };
}

export function createOnboardingResumeTokenHelpers(options: {
  secret: string;
  defaultTtlMs?: number;
  now?: () => number;
  nonceFactory?: () => string;
}): OnboardingResumeTokenHelpers {
  validateSecret(options.secret);

  const now = options.now;
  const defaultTtlMs = options.defaultTtlMs;

  return {
    sign: (params: SignOnboardingResumeTokenParams) => {
      return signOnboardingResumeToken(
        {
          ...params,
          ttlMs: params.ttlMs ?? defaultTtlMs,
        },
        {
          secret: options.secret,
          now,
          nonceFactory: options.nonceFactory,
        }
      );
    },
    verify: (
      token: string,
      verifyOptions: Omit<VerifyOnboardingResumeTokenOptions, 'secret' | 'now'> = {}
    ) => {
      return verifyOnboardingResumeToken(token, {
        ...verifyOptions,
        secret: options.secret,
        now,
      });
    },
    hash: hashOnboardingResumeToken,
  };
}
