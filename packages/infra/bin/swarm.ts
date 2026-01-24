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
const domainBase = getContextValue<string>('domainBase', envConfig) || 'rati.chat';
const stackSubdomain = getContextValue<string>('stackSubdomain', envConfig) || 'swarm';
const computedAdminDomain = computeStackDomain({ environment, stackSubdomain, baseDomain: domainBase });

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
const enableClaudeCode = (getContextValue<boolean>('enableClaudeCode', envConfig) ?? false) as boolean;
const claudeCodeUseOpenRouter = (getContextValue<boolean>('claudeCodeUseOpenRouter', envConfig) ?? false) as boolean;
// Enable shared handlers (Twitter mention polling, autonomous tweets, shared queues)
const enableSharedHandlers = (getContextValue<boolean>('enableSharedHandlers', envConfig) ?? true) as boolean;
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
  : 'swarm';

// Check if we should use split stacks (new) or monolithic stack (legacy)
// Default to false for backward compatibility during migration
const useSplitStacks = (app.node.tryGetContext('splitStacks') as boolean | undefined) ?? false;

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
  const sharedInfraStack = new SharedInfraStack(app, `SwarmShared-${environment}${nameSuffix}`, {
    environment,
    nameSuffix,
    enableCdn: true,
    galleryDomain,
    galleryCertificateArn,
    env: stackEnv,
    description: `Swarm Shared Infrastructure (${environment})`,
  });

  // 2. Admin API Stack (depends on shared, changes with code updates)
  const adminApiStack = new AdminApiStack(app, `SwarmApi-${environment}${nameSuffix}`, {
    environment,
    nameSuffix,
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
    enableSharedHandlers,
    secretPrefix,
    env: stackEnv,
    description: `Swarm Admin API (${environment})`,
  });
  adminApiStack.addDependency(sharedInfraStack);

  // 3. Admin UI Stack (depends on API for origin, changes with UI updates)
  const adminUiStack = new AdminUiStack(app, `SwarmUi-${environment}${nameSuffix}`, {
    environment,
    nameSuffix,
    adminApiStack,
    adminDomain,
    adminCertificateArn,
    env: stackEnv,
    description: `Swarm Admin UI (${environment})`,
  });
  adminUiStack.addDependency(adminApiStack);

  // 4. Avatars Stack (depends on shared and API, changes with avatar updates)
  const avatarsStack = new AvatarsStack(app, `SwarmAvatars-${environment}${nameSuffix}`, {
    environment,
    nameSuffix,
    sharedInfraStack,
    adminApiStack,
    avatarsPath,
    handlersPath,
    avatarIds,
    replicateApiKeyArn,
    secretPrefix,
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
    env: stackEnv,
    description: `Swarm AI Avatar Framework (${environment})`,
  });
}

app.synth();
