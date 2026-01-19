/**
 * Swarm Stack
 * Main CDK stack that deploys shared infrastructure and avatars
 */
import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { Construct } from 'constructs';
import { SharedInfrastructure } from '../constructs/shared.js';
import { AvatarConstruct } from '../constructs/avatar.js';
import { AdminUi } from '../constructs/admin-ui.js';
import { AdminApiConstruct } from '../constructs/admin-api.js';
import { ClaudeCodeWorker } from '../constructs/claude-code-worker.js';
import type { AvatarConfig } from '@swarm/core';

export interface SwarmStackProps extends cdk.StackProps {
  /**
   * Environment name (dev, staging, prod)
   */
  environment: string;

  /**
   * Path to avatars directory
   */
  avatarsPath: string;

  /**
   * Path to compiled handlers
   */
  handlersPath: string;

  /**
   * Enable CloudFront CDN
   */
  enableCdn?: boolean;

  /**
   * Specific avatars to deploy (default: all)
   */
  avatarIds?: string[];

  /**
   * Custom domain for Admin UI (e.g., 'admin-staging.rati.chat')
   */
  adminDomain?: string;

  /**
   * ACM certificate ARN for Admin UI custom domain (must be in us-east-1)
   */
  adminCertificateArn?: string;

  /**
   * Cloudflare Access team domain (e.g., 'yourteam.cloudflareaccess.com')
   */
  cloudflareTeamDomain?: string;

  /**
   * Admin emails (comma-separated)
   */
  adminEmails?: string;

  /**
   * Admin wallet addresses (comma-separated Solana public keys)
   * These wallets can see all avatars regardless of creator
   */
  adminWallets?: string;

  /**
   * OpenRouter API key secret ARN
   */
  openRouterApiKeyArn?: string;

  /**
   * Replicate API key secret ARN (for image/video generation trial)
   */
  replicateApiKeyArn?: string;

  /**
   * Helius API key secret ARN (for Solana RPC + burn verification)
   */
  heliusApiKeyArn?: string;

  /**
   * Custom domain for gallery CDN (e.g., 'gallery.rati.chat' or 'gallery-staging.rati.chat')
   * Images will be served from https://{galleryDomain}/avatars/{avatarId}/images/{imageId}.png
   */
  galleryDomain?: string;

  /**
   * ACM certificate ARN for gallery CDN (must be in us-east-1, can be same wildcard cert)
   */
  galleryCertificateArn?: string;

  /**
   * Web search API key secret ARN (for property research)
   */
  webSearchApiKeyArn?: string;

  /**
   * Web search provider (default: serpapi)
   */
  webSearchProvider?: string;

  /**
   * Crossmint API key secret ARN (for server-side JWT verification)
   */
  crossmintApiKeyArn?: string;

  /**
   * Privy App ID (non-secret)
   */
  privyAppId?: string;

  /**
   * Privy App Secret ARN (required for server-side user lookup)
   */
  privyAppSecretArn?: string;

  /**
   * Privy JWT verification key ARN (required for access token verification)
   */
  privyJwtVerificationKeyArn?: string;

  /**
   * Anthropic API key secret ARN (for Claude Code worker)
   */
  anthropicApiKeyArn?: string;

  /**
   * Enable Claude Code worker (default: false)
   */
  enableClaudeCode?: boolean;

  /**
   * Claude Code worker min capacity (default: 0 - scales to zero)
   */
  claudeCodeMinCapacity?: number;

  /**
   * Claude Code worker max capacity (default: 5)
   */
  claudeCodeMaxCapacity?: number;

  /**
   * Use OpenRouter instead of direct Anthropic API for Claude Code
   */
  claudeCodeUseOpenRouter?: boolean;
}

export class SwarmStack extends cdk.Stack {
  public readonly shared: SharedInfrastructure;
  public readonly adminUi: AdminUi;
  public readonly adminApi?: AdminApiConstruct;
  public readonly claudeCodeWorker?: ClaudeCodeWorker;
  public readonly avatars: Map<string, AvatarConstruct> = new Map();

  constructor(scope: Construct, id: string, props: SwarmStackProps) {
    super(scope, id, props);

    const {
      environment,
      avatarsPath,
      handlersPath,
      enableCdn = true,
      avatarIds: requestedAvatarIds,
      adminDomain,
      adminCertificateArn,
      cloudflareTeamDomain,
      adminEmails,
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
      anthropicApiKeyArn,
      enableClaudeCode = false,
      claudeCodeMinCapacity = 0,
      claudeCodeMaxCapacity = 5,
      claudeCodeUseOpenRouter = false,
    } = props;

    // Create shared infrastructure
    this.shared = new SharedInfrastructure(this, 'Shared', {
      environment,
      enableCdn,
      cdnDomain: galleryDomain,
      cdnCertificateArn: galleryCertificateArn,
    });

    // Create Admin API if Cloudflare Access is configured
    if (cloudflareTeamDomain && adminEmails) {
      this.adminApi = new AdminApiConstruct(this, 'AdminApi', {
        cloudflareTeamDomain,
        adminEmails,
        adminWallets: props.adminWallets,
        openRouterApiKeyArn,
        replicateApiKeyArn,
        heliusApiKeyArn,
        webSearchApiKeyArn,
        webSearchProvider,
        crossmintApiKeyArn,
        privyAppId,
        privyAppSecretArn,
        privyJwtVerificationKeyArn,
        environment,
        adminDomain,
        // Use adminDomain for API callbacks - API is served via CloudFront /api/* path
        // No apiCertificateArn means no API Gateway custom domain is created
        apiDomain: adminDomain,
        stateTable: this.shared.stateTable,
        // Media infrastructure for image/video generation
        mediaBucket: this.shared.mediaBucket,
        mediaCdn: this.shared.distribution,
        cdnUrl: this.shared.cdnUrl, // Use custom domain if configured
        // Dependency layer with sharp for image processing
        dependencyLayer: this.shared.dependencyLayer,
      });
    }

    // Create Admin UI with CloudFront
    // Extract hostname from API Gateway endpoint: https://xxx.execute-api.region.amazonaws.com
    // Use Fn.select to parse at deploy time since apiEndpoint is a CloudFormation token
    const apiGatewayHost = this.adminApi?.apiEndpoint 
      ? cdk.Fn.select(2, cdk.Fn.split('/', this.adminApi.apiEndpoint)) // Split by '/' and get index 2 (hostname)
      : undefined;
    
    this.adminUi = new AdminUi(this, 'AdminUi', {
      environment,
      domainName: adminDomain,
      certificateArn: adminCertificateArn,
      // Use raw API Gateway endpoint hostname for CloudFront origin
      apiDomain: apiGatewayHost,
    });

    // Create Claude Code worker if enabled
    if (enableClaudeCode) {
      // Create a shared callback queue for Claude Code results
      const claudeCodeCallbackQueue = new sqs.Queue(this, 'ClaudeCodeCallbackQueue', {
        queueName: `swarm-claude-code-callbacks-${environment}.fifo`,
        fifo: true,
        contentBasedDeduplication: true,
        visibilityTimeout: cdk.Duration.seconds(60),
      });

      this.claudeCodeWorker = new ClaudeCodeWorker(this, 'ClaudeCodeWorker', {
        environment,
        cluster: this.shared.discordCluster, // Reuse existing ECS cluster
        stateTable: this.shared.stateTable,
        responseQueue: claudeCodeCallbackQueue,
        anthropicApiKeyArn,
        openRouterApiKeyArn,
        useOpenRouter: claudeCodeUseOpenRouter,
        minCapacity: claudeCodeMinCapacity,
        maxCapacity: claudeCodeMaxCapacity,
        handlersCodePath: handlersPath,
        dependencyLayer: this.shared.dependencyLayer,
      });

      // Output the queue URL for avatars to use
      new cdk.CfnOutput(this, 'ClaudeCodeQueueUrl', {
        value: this.claudeCodeWorker.queue.queueUrl,
        description: 'Claude Code task queue URL',
        exportName: `swarm-claude-code-queue-url-${environment}`,
      });

      new cdk.CfnOutput(this, 'ClaudeCodeCallbackQueueUrl', {
        value: claudeCodeCallbackQueue.queueUrl,
        description: 'Claude Code callback queue URL',
        exportName: `swarm-claude-code-callback-queue-url-${environment}`,
      });
    }

    // Load and deploy avatars (skip if avatars directory doesn't exist)
    if (!fs.existsSync(avatarsPath)) {
      console.log(`Avatars directory not found at ${avatarsPath}, skipping avatar deployment`);
    } else {
      const discoveredAvatarIds = fs.readdirSync(avatarsPath)
        .filter(f => {
          const fullPath = path.join(avatarsPath, f);
          return fs.statSync(fullPath).isDirectory() && !f.startsWith('.') && f !== 'node_modules';
        })
        .filter(f => !requestedAvatarIds || requestedAvatarIds.includes(f));

      for (const avatarId of discoveredAvatarIds) {
        const configPath = path.join(avatarsPath, avatarId, 'config.yaml');
        
        if (!fs.existsSync(configPath)) {
          console.warn(`Skipping ${avatarId}: no config.yaml found`);
          continue;
        }

        const configYaml = fs.readFileSync(configPath, 'utf-8');
        const config: AvatarConfig = yaml.parse(configYaml);

        // Ensure avatar ID matches directory name
        config.id = avatarId;

        // Read persona file if exists
        const personaPath = path.join(avatarsPath, avatarId, 'persona.md');
        if (fs.existsSync(personaPath)) {
          config.persona = fs.readFileSync(personaPath, 'utf-8');
        }

        // Create avatar
        const avatar = new AvatarConstruct(this, `Avatar-${avatarId}`, {
          config,
          stateTable: this.shared.stateTable,
          activityTable: this.shared.activityTable,
          mediaBucket: this.shared.mediaBucket,
          dependencyLayer: this.shared.dependencyLayer,
          handlersCodePath: handlersPath,
          cdnUrl: this.shared.cdnUrl,
          environment,
          discordCluster: this.shared.discordCluster,
          replicateApiKeyArn,
        });

        this.avatars.set(avatarId, avatar);
      }
    }

    // Stack outputs
    new cdk.CfnOutput(this, 'AvatarCount', {
      value: String(this.avatars.size),
      description: 'Number of avatars deployed',
    });
  }
}
