#!/usr/bin/env node
/**
 * CDK App Entry Point
 */
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SwarmStack } from '../src/stacks/swarm-stack.js';

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

// Resolve paths relative to monorepo root
// From packages/infra/bin/ -> go up 3 levels to reach monorepo root
const monorepoRoot = path.resolve(__dirname, '../../..');
const avatarsPath = path.join(monorepoRoot, 'avatars');
const handlersPath = path.join(monorepoRoot, 'packages/handlers/dist');

new SwarmStack(app, `SwarmStack-${environment}`, {
  environment,
  avatarsPath,
  handlersPath,
  enableCdn: true, // CDN required for media to be accessible (S3 bucket is private)
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
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  description: `Swarm AI Avatar Framework (${environment})`,
});

app.synth();
