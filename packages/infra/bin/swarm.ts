#!/usr/bin/env node
/**
 * CDK App Entry Point
 * 
 * Stacks are organized for parallel deployment:
 * 1. SharedInfraStack - DynamoDB, S3, CDN, Lambda layer (rarely changes)
 * 2. AdminApiStack - API Gateway, Lambda handlers (changes with code)
 * 3. AdminUiStack - CloudFront for UI (changes with UI)
 * 4. AvatarsStack - Avatar configs (changes with avatar updates)
 * 
 * Legacy SwarmStack is still available for backward compatibility.
 */
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SwarmStack } from '../src/stacks/swarm-stack.js';
import { SharedInfraStack } from '../src/stacks/shared-infra-stack.js';
import { AdminApiStack } from '../src/stacks/admin-api-stack.js';
import { AdminUiStack } from '../src/stacks/admin-ui-stack.js';
import { AvatarsStack } from '../src/stacks/avatars-stack.js';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = new cdk.App();

type EnvConfig = Record<string, unknown>;

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  if (normalized === '1') return true;
  if (normalized === '0') return false;
  return undefined;
}

function normalizeEnvironmentName(env: string): string {
  // Support both "production" (GitHub env) and "prod" (CDK stack env)
  return env === 'production' ? 'prod' : env;
}

function computeStackDomain(args: { environment: string; stackSubdomain: string; baseDomain: string }): string | undefined {
  const environment = normalizeEnvironmentName(args.environment);
  if (!args.stackSubdomain || !args.baseDomain) return undefined;

  if (environment === 'prod') {
    return `${args.stackSubdomain}.${args.baseDomain}`;
  }

  // Common pattern: <env>-<stack>.<base>
  if (environment === 'staging') {
    return `${environment}-${args.stackSubdomain}.${args.baseDomain}`;
  }

  return undefined;
}

function getContextValue<T>(key: string, envConfig: EnvConfig): T | undefined {
  // Prefer explicit CDK context overrides (e.g. `-c adminDomain=...`) over envConfig.
  const fromContext = app.node.tryGetContext(key);
  if (fromContext !== undefined) return fromContext as T;

  const fromEnv = (envConfig as Record<string, unknown>)[key];
  return fromEnv as T | undefined;
}

// Get environment from context or default
const rawEnvironment = (app.node.tryGetContext('environment') as string | undefined) || 'dev';
const environment = normalizeEnvironmentName(rawEnvironment);
const avatarIds = (app.node.tryGetContext('avatars') as string | undefined)?.split(',');

// Get environment-specific config
const environments = (app.node.tryGetContext('environments') as Record<string, EnvConfig> | undefined) || {};
const envConfig = environments[environment] || environments[rawEnvironment] || {};

// Domain configuration
// Prefer explicit adminDomain, but allow a computed stack domain for easier multi-stack deployments.
const disableComputedAdminDomain =
  parseBoolean(getContextValue<unknown>('disableComputedAdminDomain', envConfig)) ?? false;
const domainBase = getContextValue<string>('domainBase', envConfig) || 'rati.chat';
const stackSubdomain = getContextValue<string>('stackSubdomain', envConfig) || 'swarm';
const computedAdminDomain = disableComputedAdminDomain
  ? undefined
  : computeStackDomain({ environment, stackSubdomain, baseDomain: domainBase });

const adminDomain = getContextValue<string>('adminDomain', envConfig) || computedAdminDomain;
const adminCertificateArn = getContextValue<string>('adminCertificateArn', envConfig);
const cloudflareTeamDomain =
  getContextValue<string>('cloudflareTeamDomain', envConfig) ||
  // Back-compat for older env config key name
  (envConfig as Record<string, unknown>).cloudflareTeamDomain as string | undefined;
const adminEmails = getContextValue<string>('adminEmails', envConfig);
const adminWallets = getContextValue<string>('adminWallets', envConfig);
const openRouterApiKeyArn = getContextValue<string>('openRouterApiKeyArn', envConfig);
const replicateApiKeyArn = getContextValue<string>('replicateApiKeyArn', envConfig);
const heliusApiKeyArn = getContextValue<string>('heliusApiKeyArn', envConfig);
const webSearchApiKeyArn = getContextValue<string>('webSearchApiKeyArn', envConfig);
const webSearchProvider = getContextValue<string>('webSearchProvider', envConfig);
const crossmintApiKeyArn = getContextValue<string>('crossmintApiKeyArn', envConfig);
const privyAppId = getContextValue<string>('privyAppId', envConfig);
const privyAppSecretArn = getContextValue<string>('privyAppSecretArn', envConfig);
const privyJwtVerificationKeyArn = getContextValue<string>('privyJwtVerificationKeyArn', envConfig);
const galleryDomain = getContextValue<string>('galleryDomain', envConfig);
const galleryCertificateArn = getContextValue<string>('galleryCertificateArn', envConfig);
const enableClaudeCode = parseBoolean(getContextValue<unknown>('enableClaudeCode', envConfig)) ?? false;
const claudeCodeUseOpenRouter = parseBoolean(getContextValue<unknown>('claudeCodeUseOpenRouter', envConfig)) ?? false;
const anthropicApiKeyArn = getContextValue<string>('anthropicApiKeyArn', envConfig);
const secretPrefixRaw = getContextValue<string>('secretPrefix', envConfig);
const stackHashRaw = getContextValue<string>('stackHash', envConfig);

function normalizeStackHash(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!/^[a-f0-9]{6}$/i.test(trimmed)) {
    throw new Error(`Invalid stackHash "${value}". Expected 6 hex chars.`);
  }
  return trimmed.toLowerCase();
}

const stackHash = normalizeStackHash(stackHashRaw);
const nameSuffix = stackHash ? `-${stackHash}` : '';
const secretPrefix = (secretPrefixRaw && secretPrefixRaw.trim())
  ? secretPrefixRaw.trim()
  : (nameSuffix ? `swarm${nameSuffix}` : 'swarm');

// Check if we should use split stacks (new) or monolithic stack (legacy)
// Default to false for backward compatibility during migration
const useSplitStacks = parseBoolean(app.node.tryGetContext('splitStacks')) ?? false;

// When migrating from the monolithic stack, shared resources may already exist.
// This flag makes SharedInfraStack adopt/import those shared resources instead of creating them.
const useExistingSharedResources =
  parseBoolean(getContextValue<unknown>('useExistingSharedResources', envConfig)) ?? false;
const existingDependencyLayerArn = getContextValue<string>('existingDependencyLayerArn', envConfig);
const existingCdnDistributionId = getContextValue<string>('existingCdnDistributionId', envConfig);

// Stack/resource suffix strategy:
// - Normal mode: stackHash (nameSuffix) applies to stack IDs and resource names.
// - Migration mode (useExistingSharedResources=true): keep stack IDs stable (no suffix),
//   adopt existing shared resources (no suffix), and suffix ONLY non-shared resources with
//   '-split' when no stackHash is provided to avoid collisions with the legacy monolithic stack.
const stackIdSuffix = (useSplitStacks && !useExistingSharedResources) ? nameSuffix : '';
const sharedResourceSuffix = useExistingSharedResources ? '' : nameSuffix;
const nonSharedResourceSuffix = (useExistingSharedResources && !nameSuffix) ? '-split' : nameSuffix;

// If we are creating a parallel set of non-shared resources during migration and the user
// didn't provide an explicit secretPrefix, avoid collisions by defaulting to a suffixed prefix.
const secretPrefixForSplitStacks = (useSplitStacks && useExistingSharedResources && !secretPrefixRaw && nonSharedResourceSuffix)
  ? `swarm${nonSharedResourceSuffix}`
  : secretPrefix;

// Enable shared handlers (Twitter mention polling, autonomous tweets, shared queues)
// Default to true. Telegram ingress uses the shared multi-tenant webhook.
const enableSharedHandlersExplicit = parseBoolean(getContextValue<unknown>('enableSharedHandlers', envConfig));
const enableSharedHandlers = enableSharedHandlersExplicit ?? true;

// Migration guardrails: when adopting existing shared resources for split stacks without a suffix,
// many resources already exist from the legacy monolithic stack.
const isMigrationSplitWithoutSuffix = useSplitStacks && useExistingSharedResources && !nameSuffix;

// In migration mode, default to NOT creating shared handlers to avoid colliding with legacy function names.
// DEPRECATED: Migration mode without shared handlers uses legacy code that will be removed.
// Plan to migrate by setting enableSharedHandlers=true explicitly.
const enableSharedHandlersForDeploy =
  isMigrationSplitWithoutSuffix && enableSharedHandlersExplicit === undefined
    ? false
    : enableSharedHandlers;

if (!enableSharedHandlersForDeploy) {
  console.warn(
    '\n⚠️  DEPRECATION WARNING: Deploying without shared handlers.\n' +
    '   Telegram/Twitter shared ingress features require @swarm/handlers SharedHandlers.\n' +
    '   Set enableSharedHandlers=true to use the supported webhook/poller runtime.\n'
  );
}

// In migration mode, reuse the existing SwarmAdmin table to preserve admin data.
const useExistingAdminTable = isMigrationSplitWithoutSuffix;
const existingAdminTableName = getContextValue<string>('existingAdminTableName', envConfig);

// When deploying to an environment where S3 buckets already exist (e.g., from a previous stack
// deletion with RETAIN policy), import the existing buckets instead of trying to create new ones.
const useExistingBuckets = parseBoolean(getContextValue<unknown>('useExistingBuckets', envConfig)) ?? false;

// When the CNAME is locked by an orphaned CloudFront distribution (e.g., after a stack deletion),
// skip adding domain aliases during deployment. After deployment, use `aws cloudfront associate-alias`
// to move the CNAME to the new distribution.
const skipDomainAliases = parseBoolean(getContextValue<unknown>('skipDomainAliases', envConfig)) ?? false;

// Resolve paths relative to monorepo root
// From packages/infra/bin/ -> go up 3 levels to reach monorepo root
const monorepoRoot = path.resolve(__dirname, '../../..');
const avatarsPath = path.join(monorepoRoot, 'avatars');
const handlersPath = path.join(monorepoRoot, 'packages/handlers/dist');

const stackEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

if (useSplitStacks) {
  // ============================================
  // NEW: Split Stacks for Parallel Deployment
  // ============================================

  // 1. Shared Infrastructure Stack (deploys first, rarely changes)
  const sharedInfraStack = new SharedInfraStack(app, `SwarmShared-${environment}${stackIdSuffix}`, {
    environment,
    nameSuffix: sharedResourceSuffix,
    enableCdn: true,
    galleryDomain,
    galleryCertificateArn,
    useExistingResources: useExistingSharedResources,
    existingDependencyLayerArn,
    existingCdnDistributionId,
    env: stackEnv,
    description: `Swarm Shared Infrastructure (${environment})`,
  });

  // 2. Admin API Stack (depends on shared, changes with code updates)
  const adminApiStack = new AdminApiStack(app, `SwarmApi-${environment}${stackIdSuffix}`, {
    environment,
    nameSuffix: nonSharedResourceSuffix,
    sharedInfraStack,
    handlersPath,
    adminDomain,
    cloudflareTeamDomain,
    adminEmails,
    adminWallets,
    openRouterApiKeyArn,
    replicateApiKeyArn,
    heliusApiKeyArn,
    webSearchApiKeyArn,
    webSearchProvider,
    crossmintApiKeyArn,
    privyAppId,
    privyAppSecretArn,
    privyJwtVerificationKeyArn,
    anthropicApiKeyArn,
    enableClaudeCode,
    claudeCodeUseOpenRouter,
    enableSharedHandlers: enableSharedHandlersForDeploy,
    useExistingAdminTable,
    existingAdminTableName,
    secretPrefix: secretPrefixForSplitStacks,
    env: stackEnv,
    description: `Swarm Admin API (${environment})`,
  });
  adminApiStack.addDependency(sharedInfraStack);

  // 3. Admin UI Stack (depends on API for origin, changes with UI updates)
  const adminUiStack = new AdminUiStack(app, `SwarmUi-${environment}${stackIdSuffix}`, {
    environment,
    nameSuffix: nonSharedResourceSuffix,
    adminApiStack,
    adminDomain,
    adminCertificateArn,
    env: stackEnv,
    description: `Swarm Admin UI (${environment})`,
  });
  adminUiStack.addDependency(adminApiStack);

  // 4. Avatars Stack (depends on shared and API, changes with avatar updates)
  const avatarsStack = new AvatarsStack(app, `SwarmAvatars-${environment}${stackIdSuffix}`, {
    environment,
    nameSuffix: nonSharedResourceSuffix,
    sharedInfraStack,
    adminApiStack,
    avatarsPath,
    handlersPath,
    avatarIds,
    replicateApiKeyArn,
    secretPrefix: secretPrefixForSplitStacks,
    env: stackEnv,
    description: `Swarm Avatars (${environment})`,
  });
  avatarsStack.addDependency(sharedInfraStack);
  avatarsStack.addDependency(adminApiStack);

} else {
  // ============================================
  // LEGACY: Monolithic Stack (default for now)
  // ============================================
  new SwarmStack(app, `SwarmStack-${environment}${nameSuffix}`, {
    environment,
    nameSuffix,
    avatarsPath,
    handlersPath,
    enableCdn: true,
    avatarIds,
    adminDomain,
    adminCertificateArn,
    cloudflareTeamDomain,
    adminEmails,
    adminWallets,
    openRouterApiKeyArn,
    replicateApiKeyArn,
    heliusApiKeyArn,
    webSearchApiKeyArn,
    webSearchProvider,
    crossmintApiKeyArn,
    privyAppId,
    privyAppSecretArn,
    privyJwtVerificationKeyArn,
    galleryDomain,
    galleryCertificateArn,
    enableClaudeCode,
    claudeCodeUseOpenRouter,
    enableSharedHandlers,
    secretPrefix,
    useExistingBuckets,
    skipDomainAliases,
    env: stackEnv,
    description: `Swarm AI Avatar Framework (${environment})`,
  });
}

app.synth();
