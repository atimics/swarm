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

// Get environment from context or default
const environment = app.node.tryGetContext('environment') || 'dev';
const avatarIds = app.node.tryGetContext('avatars')?.split(',');

// Get environment-specific config
const environments = app.node.tryGetContext('environments') || {};
const envConfig = environments[environment] || {};
const adminDomain = app.node.tryGetContext('adminDomain') || envConfig.adminDomain;
const adminCertificateArn = app.node.tryGetContext('adminCertificateArn') || envConfig.adminCertificateArn;
const cloudflareTeamDomain = app.node.tryGetContext('cloudflareTeamDomain') || envConfig.cloudflareTeamDomain;
const adminEmails = app.node.tryGetContext('adminEmails') || envConfig.adminEmails;
const adminWallets = app.node.tryGetContext('adminWallets') || envConfig.adminWallets;
const openRouterApiKeyArn = app.node.tryGetContext('openRouterApiKeyArn') || envConfig.openRouterApiKeyArn;
const replicateApiKeyArn = app.node.tryGetContext('replicateApiKeyArn') || envConfig.replicateApiKeyArn;
const heliusApiKeyArn = app.node.tryGetContext('heliusApiKeyArn') || envConfig.heliusApiKeyArn;
const webSearchApiKeyArn = app.node.tryGetContext('webSearchApiKeyArn') || envConfig.webSearchApiKeyArn;
const webSearchProvider = app.node.tryGetContext('webSearchProvider') || envConfig.webSearchProvider;
const crossmintApiKeyArn = app.node.tryGetContext('crossmintApiKeyArn') || envConfig.crossmintApiKeyArn;
const privyAppId = app.node.tryGetContext('privyAppId') || envConfig.privyAppId;
const privyAppSecretArn = app.node.tryGetContext('privyAppSecretArn') || envConfig.privyAppSecretArn;
const privyJwtVerificationKeyArn = app.node.tryGetContext('privyJwtVerificationKeyArn') || envConfig.privyJwtVerificationKeyArn;
const galleryDomain = app.node.tryGetContext('galleryDomain') || envConfig.galleryDomain;
const galleryCertificateArn = app.node.tryGetContext('galleryCertificateArn') || envConfig.galleryCertificateArn;
const enableClaudeCode = app.node.tryGetContext('enableClaudeCode') ?? envConfig.enableClaudeCode ?? false;
const claudeCodeUseOpenRouter = app.node.tryGetContext('claudeCodeUseOpenRouter') ?? envConfig.claudeCodeUseOpenRouter ?? false;

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
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  description: `Swarm AI Avatar Framework (${environment})`,
});

app.synth();
