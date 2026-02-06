/**
 * Onboarding Auth/Account Resolver
 *
 * Canonical resolver for onboarding auth/account decisions.
 * Used to deterministically resolve:
 * - allow_continue
 * - allow_link
 * - require_switch
 * and typed auth failures such as session_expired / actor_not_authorized.
 */
import {
  getAccountIdForIdentity,
  resolveAccountForIdentity,
  type Identity,
  type ResolveAccountResult,
} from './identity-service.js';

export type OnboardingAuthOutcome = 'allow_continue' | 'allow_link' | 'require_switch';
export type OnboardingAuthErrorCode =
  | 'session_expired'
  | 'actor_not_authorized'
  | 'account_intent_required'
  | 'require_switch';
export type OnboardingAuthIntent = 'link' | 'switch';

export interface OnboardingAuthSuccessResult {
  success: true;
  outcome: 'allow_continue' | 'allow_link';
  accountId: string;
  targetIdentities: Identity[];
  linkedIdentities?: Identity[];
}

export interface OnboardingAuthFailureResult {
  success: false;
  code: OnboardingAuthErrorCode;
  error: string;
  outcome?: OnboardingAuthOutcome;
  accountId?: string;
  switchAccountId?: string;
  identity?: Identity;
  requiredIntent?: OnboardingAuthIntent;
  providedIntent?: OnboardingAuthIntent;
  targetIdentities?: Identity[];
}

export type OnboardingAuthResult = OnboardingAuthSuccessResult | OnboardingAuthFailureResult;

type SessionScopedResolveParams = {
  mode: 'session';
  sessionAccountId?: string | null;
  avatarOwnerAccountId: string;
  targetIdentities?: Identity[];
  intent?: OnboardingAuthIntent;
  requireExplicitLinkIntent?: boolean;
};

type IdentityScopedResolveParams = {
  mode: 'identity';
  primaryIdentity: Identity;
  additionalIdentities?: Identity[];
  createIfNotFound?: boolean;
};

export type ResolveOnboardingAuthAccountParams =
  | SessionScopedResolveParams
  | IdentityScopedResolveParams;

export interface OnboardingAuthResolverDeps {
  getAccountIdForIdentity: (identity: Identity) => Promise<string | null>;
  resolveAccountForIdentity: (params: {
    primaryIdentity: Identity;
    additionalIdentities?: Identity[];
    createIfNotFound?: boolean;
  }) => Promise<ResolveAccountResult>;
}

function getDefaultDeps(): OnboardingAuthResolverDeps {
  return {
    getAccountIdForIdentity,
    resolveAccountForIdentity,
  };
}

function dedupeIdentities(identities: Identity[]): Identity[] {
  const seen = new Set<string>();
  const deduped: Identity[] = [];

  for (const identity of identities) {
    const key = `${identity.type}:${identity.providerId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(identity);
  }

  return deduped;
}

async function resolveSessionScoped(
  params: SessionScopedResolveParams,
  deps: OnboardingAuthResolverDeps
): Promise<OnboardingAuthResult> {
  const targetIdentities = dedupeIdentities(params.targetIdentities ?? []);

  if (!params.sessionAccountId) {
    return {
      success: false,
      code: 'session_expired',
      error: 'Session expired',
      targetIdentities,
    };
  }

  if (params.sessionAccountId !== params.avatarOwnerAccountId) {
    return {
      success: false,
      code: 'actor_not_authorized',
      error: 'Actor is not authorized for onboarding mutations on this avatar',
      accountId: params.sessionAccountId,
      targetIdentities,
    };
  }

  for (const identity of targetIdentities) {
    const existingAccountId = await deps.getAccountIdForIdentity(identity);
    if (existingAccountId && existingAccountId !== params.avatarOwnerAccountId) {
      return {
        success: false,
        code: 'require_switch',
        outcome: 'require_switch',
        error: `${identity.type} identity is linked to a different account`,
        accountId: params.avatarOwnerAccountId,
        switchAccountId: existingAccountId,
        identity,
        requiredIntent: 'switch',
        providedIntent: params.intent,
        targetIdentities,
      };
    }
  }

  if (targetIdentities.length === 0) {
    return {
      success: true,
      outcome: 'allow_continue',
      accountId: params.avatarOwnerAccountId,
      targetIdentities,
    };
  }

  const intent = params.intent;
  if (params.requireExplicitLinkIntent && intent !== 'link') {
    return {
      success: false,
      code: 'account_intent_required',
      outcome: 'allow_link',
      error: 'Explicit link intent is required',
      accountId: params.avatarOwnerAccountId,
      requiredIntent: 'link',
      providedIntent: intent,
      targetIdentities,
    };
  }

  return {
    success: true,
    outcome: 'allow_link',
    accountId: params.avatarOwnerAccountId,
    targetIdentities,
  };
}

async function resolveIdentityScoped(
  params: IdentityScopedResolveParams,
  deps: OnboardingAuthResolverDeps
): Promise<OnboardingAuthResult> {
  const additionalIdentities = dedupeIdentities(params.additionalIdentities ?? []);
  const targetIdentities = dedupeIdentities([params.primaryIdentity, ...additionalIdentities]);

  const resolution = await deps.resolveAccountForIdentity({
    primaryIdentity: params.primaryIdentity,
    additionalIdentities,
    createIfNotFound: params.createIfNotFound ?? true,
  });

  if (!resolution.success) {
    return {
      success: false,
      code: 'require_switch',
      outcome: 'require_switch',
      error: `${resolution.conflict.identity.type} identity is linked to a different account`,
      switchAccountId: resolution.conflict.existingAccountId,
      identity: resolution.conflict.identity,
      requiredIntent: 'switch',
      targetIdentities,
    };
  }

  return {
    success: true,
    outcome: resolution.linkedIdentities.length > 0 ? 'allow_link' : 'allow_continue',
    accountId: resolution.accountId,
    linkedIdentities: resolution.linkedIdentities,
    targetIdentities,
  };
}

export async function resolveOnboardingAuthAccount(
  params: ResolveOnboardingAuthAccountParams,
  deps: OnboardingAuthResolverDeps = getDefaultDeps()
): Promise<OnboardingAuthResult> {
  if (params.mode === 'session') {
    return resolveSessionScoped(params, deps);
  }

  return resolveIdentityScoped(params, deps);
}

export function onboardingAuthErrorStatusCode(code: OnboardingAuthErrorCode): number {
  switch (code) {
    case 'session_expired':
      return 401;
    case 'actor_not_authorized':
      return 403;
    case 'require_switch':
      return 409;
    case 'account_intent_required':
      return 409;
    default:
      return 400;
  }
}
