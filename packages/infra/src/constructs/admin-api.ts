/**
 * CDK Construct for Admin API Infrastructure
 */
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';

export interface AdminApiConstructProps {
  /**
   * Cloudflare Access team domain (e.g., 'yourteam.cloudflareaccess.com')
   */
  cloudflareTeamDomain: string;

  /**
   * Comma-separated list of admin emails
   */
  adminEmails: string;

  /**
   * Comma-separated list of admin wallet addresses (Solana public keys)
   * These wallets can see all avatars regardless of creator
   */
  adminWallets?: string;

  /**
   * Global OpenRouter API key (stored in Secrets Manager)
   */
  openRouterApiKeyArn?: string;

  /**
   * Global Replicate API key (stored in Secrets Manager)
   * Used for image/video generation with a trial limit per avatar
   */
  replicateApiKeyArn?: string;

  /**
   * Helius API key for Solana RPC (NFT queries, etc.)
   * Required for NFT-gated access
   */
  heliusApiKey?: string;

  /**
   * Helius API key secret ARN (preferred over inline value)
   */
  heliusApiKeyArn?: string;

  /**
   * Web search API key (for property research)
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
   * Privy App Secret ARN (required to fetch Privy users server-side)
   */
  privyAppSecretArn?: string;

  /**
   * Privy JWT verification key ARN (required to verify Privy access tokens)
   */
  privyJwtVerificationKeyArn?: string;

  /**
   * Environment (development/production)
   */
  environment?: string;

  /**
   * Admin UI domain for CORS (e.g., 'admin.example.com')
   */
  adminDomain?: string;

  /**
   * Custom domain for the API (e.g., 'api.example.com')
   */
  apiDomain?: string;

  /**
   * ACM certificate ARN for the API custom domain
   */
  apiCertificateArn?: string;

  /**
   * Shared state table for syncing avatar configs to handlers
   */
  stateTable?: dynamodb.ITable;

  /**
   * Media bucket for storing generated images/videos
   */
  mediaBucket?: s3.IBucket;

  /**
   * CDN distribution for media
   */
  mediaCdn?: cloudfront.IDistribution;

  /**
   * CDN URL for media (e.g., 'https://gallery.rati.chat')
   * If provided, this takes precedence over mediaCdn.distributionDomainName
   */
  cdnUrl?: string;

  /**
   * Lambda layer with shared dependencies (including sharp for image processing)
   */
  dependencyLayer?: lambda.ILayerVersion;

  /**
   * Optional Telegram webhook Lambda to use for /webhook/telegram/{avatarId}.
   * When provided, Admin API will route the webhook to this function (preferred for shared runtime).
   */
  telegramWebhookFunction?: lambda.IFunction;
}

export class AdminApiConstruct extends Construct {
  public readonly api: apigateway.HttpApi;
  public readonly apiEndpoint: string;
  public readonly customDomain?: apigateway.DomainName;
  public readonly table: dynamodb.Table;
  public readonly chatHandler: lambda.Function;
  public readonly mediaConvertHandler?: lambda.Function;

  constructor(scope: Construct, id: string, props: AdminApiConstructProps) {
    super(scope, id);

    const {
      cloudflareTeamDomain,
      adminEmails,
      environment = 'development',
      adminDomain,
      webSearchProvider,
      stateTable,
      mediaBucket,
      mediaCdn,
      cdnUrl: propsCdnUrl,
      dependencyLayer,
    } = props;

    const isProd = environment === 'prod' || environment === 'production';

    // Use provided CDN URL or fall back to distribution domain
    const cdnUrl = propsCdnUrl || (mediaCdn ? `https://${mediaCdn.distributionDomainName}` : undefined);

    // Build CORS allowed origins
    const allowedOrigins = adminDomain 
      ? [`https://${adminDomain}`]
      : ['http://localhost:5173', 'http://localhost:3000'];

    // NOTE: ApiGatewayV2 CORS allowOrigins does not support wildcard origins.
    // Bot subdomains are expected to use the same-origin CloudFront `/api/*` proxy,
    // so we do not need to enumerate each subdomain here.

    // Secrets Manager uses AWS-managed KMS key by default (alias/aws/secretsmanager).
    // We intentionally do not provision a customer-managed key to avoid the monthly CMK charge.

    // DynamoDB table for admin data
    this.table = new dynamodb.Table(this, 'AdminTable', {
      tableName: `SwarmAdmin-${environment}`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: isProd
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: isProd,
      },
      timeToLiveAttribute: 'ttl',
    });

    // GSI1 for inverted lookups (sk → pk)
    // Used for:
    // - Finding avatar by inhabitant: sk=INHABITANT#<wallet> returns pk=AVATAR#<avatarId>
    // - Listing items by type: sk=CONFIG returns all avatars
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    });


    // Note: Media jobs are queried using Scan with filter (no GSI needed)
    // Jobs have TTL so the scan is bounded by recent jobs only

    // External provider ID lookups use a mapping item (no extra GSI).

    // Response queue for async media generation callbacks
    // When Replicate finishes generating an image/video, it calls our webhook
    // which puts a message in this queue. The response sender Lambda then
    // delivers the media to Telegram.
    const responseQueue = new sqs.Queue(this, 'ResponseQueue', {
      queueName: `swarm-response-queue-${environment}`,
      visibilityTimeout: cdk.Duration.seconds(120), // Match Lambda timeout
      retentionPeriod: cdk.Duration.days(1),
      deadLetterQueue: {
        queue: new sqs.Queue(this, 'ResponseDLQ', {
          queueName: `swarm-response-dlq-${environment}`,
          retentionPeriod: cdk.Duration.days(14),
        }),
        maxReceiveCount: 3,
      },
    });

    // Chat queue for async /chat jobs (admin UI polling)
    const chatQueue = new sqs.Queue(this, 'ChatQueue', {
      queueName: `swarm-chat-queue-${environment}`,
      visibilityTimeout: cdk.Duration.seconds(600),
      retentionPeriod: cdk.Duration.days(1),
      deadLetterQueue: {
        queue: new sqs.Queue(this, 'ChatDLQ', {
          queueName: `swarm-chat-dlq-${environment}`,
          retentionPeriod: cdk.Duration.days(14),
        }),
        maxReceiveCount: 3,
      },
    });

    // Dreams queue (FIFO) for async dream generation jobs
    const dreamDlq = new sqs.Queue(this, 'DreamDLQ', {
      queueName: `swarm-dream-dlq-${environment}.fifo`,
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    const dreamQueue = new sqs.Queue(this, 'DreamQueue', {
      queueName: `swarm-dream-queue-${environment}.fifo`,
      fifo: true,
      // We provide explicit MessageDeduplicationId (jobId)
      contentBasedDeduplication: false,
      // Allow enough time for LLM + Dynamo + memory resonance work
      visibilityTimeout: cdk.Duration.minutes(5),
      retentionPeriod: cdk.Duration.days(1),
      deadLetterQueue: {
        queue: dreamDlq,
        maxReceiveCount: 3,
      },
    });

    // Secret for OpenRouter API key
    const llmApiKey = props.openRouterApiKeyArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, 'LLMApiKey', props.openRouterApiKeyArn)
      : new secretsmanager.Secret(this, 'LLMApiKey', {
          secretName: 'swarm/admin/llm-api-key',
          description: 'API key for the admin chatbot LLM',
        });

    // Secret for Replicate API key (optional - enables free trial image generation)
    const replicateApiKey = props.replicateApiKeyArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, 'ReplicateApiKey', props.replicateApiKeyArn)
      : undefined;

    // Secret for Helius API key (optional, preferred over inline value)
    const heliusApiKeySecret = props.heliusApiKeyArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, 'HeliusApiKey', props.heliusApiKeyArn)
      : undefined;

    const webSearchApiKey = props.webSearchApiKeyArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, 'WebSearchApiKey', props.webSearchApiKeyArn)
      : undefined;

    // Secret for Crossmint API key (optional - for server-side JWT verification)
    const crossmintApiKey = props.crossmintApiKeyArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, 'CrossmintApiKey', props.crossmintApiKeyArn)
      : undefined;

    // Secrets for Privy (optional - required if Privy auth endpoints are enabled)
    const privyAppSecret = props.privyAppSecretArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, 'PrivyAppSecret', props.privyAppSecretArn)
      : undefined;

    const privyJwtVerificationKey = props.privyJwtVerificationKeyArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, 'PrivyJwtVerificationKey', props.privyJwtVerificationKeyArn)
      : undefined;

    // Twitter App credentials for OAuth flow (needed by both Chat and Twitter OAuth handlers)
    const twitterAppCredentialsSecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'TwitterAppCredentials', 'swarm/global/twitter-app-credentials'
    );
    // When `apiCertificateArn` is not set, the API is served via the Admin UI CloudFront
    // distribution under the `/api/*` path (see SwarmStack wiring). In that case, OAuth
    // callbacks must include the `/api` prefix so the callback reaches the Lambda.
    const twitterOAuthCallbackUrl = props.apiDomain
      ? `https://${props.apiDomain}${props.apiCertificateArn ? '' : '/api'}/oauth/twitter/callback`
      : '';

    // Build webhook URL for Replicate callbacks
    // Note: We'll use the raw API Gateway URL (not custom domain) since Replicate
    // webhooks need to bypass Cloudflare Access. The actual URL is set after API creation.
    let replicateWebhookUrl = ''; // Will be updated after API is created

    // Internal test key for direct API testing (only in non-production)
    // Generate a random key if not in production
    const internalTestKey = environment !== 'production' 
      ? process.env.INTERNAL_TEST_KEY || `test-${Date.now()}-${Math.random().toString(36).substring(2)}`
      : '';

    // Lambda function for chat handler
    this.chatHandler = new nodejs.NodejsFunction(this, 'ChatHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/chat.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(180), // Increased for image generation with Nano Banana Pro
      memorySize: 1024, // Increased for image processing
      // Use dependency layer for sharp (pre-built with linux binaries)
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        STATE_TABLE: stateTable?.tableName || '',
        DREAM_QUEUE_URL: dreamQueue.queueUrl,
        DREAMS_ENABLED: isProd ? 'false' : 'true',
        SECRET_PREFIX: 'swarm',
        CF_ACCESS_TEAM_DOMAIN: cloudflareTeamDomain,
        ADMIN_EMAILS: adminEmails,
        LLM_ENDPOINT: 'https://openrouter.ai/api/v1/chat/completions',
        LLM_MODEL: 'anthropic/claude-haiku-4.5',
        // Keep /chat under API Gateway/CloudFront response time limits.
        // These can be overridden per-environment via Lambda env vars if needed.
        LLM_TIMEOUT_MS: '27000',
        LLM_MAX_RETRIES: '0',
        LLM_MAX_STEPS: '4',
        LLM_API_KEY_SECRET_ARN: llmApiKey.secretArn,
        WEB_SEARCH_PROVIDER: webSearchProvider || 'serpapi',
        WEB_SEARCH_API_KEY_SECRET_ARN: webSearchApiKey?.secretArn || '',
        API_DOMAIN: props.apiDomain || '',
        NODE_ENV: environment,
        // Media generation config
        MEDIA_BUCKET: mediaBucket?.bucketName || '',
        CDN_URL: cdnUrl || '',
        REPLICATE_WEBHOOK_URL: replicateWebhookUrl,
        REPLICATE_API_KEY_SECRET_ARN: replicateApiKey?.secretArn || '',
        RESPONSE_QUEUE_URL: responseQueue.queueUrl,
        CHAT_QUEUE_URL: chatQueue.queueUrl,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        // Twitter OAuth (for twitter_request_integration tool)
        TWITTER_APP_CREDENTIALS_ARN: twitterAppCredentialsSecret.secretArn,
        TWITTER_OAUTH_CALLBACK_URL: twitterOAuthCallbackUrl,
        // Internal testing (non-production only)
        INTERNAL_TEST_KEY: internalTestKey,
      },
      bundling: {
        // Sharp is provided via dependency layer (no Docker bundling needed)
        externalModules: ['@aws-sdk/*', 'sharp'],
        minify: true,
        sourceMap: true,
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            // Copy platform prompts to Lambda bundle
            `mkdir -p ${outputDir}/prompts/platforms`,
            `cp -r ${inputDir}/../../../../prompts/platforms/* ${outputDir}/prompts/platforms/ 2>/dev/null || true`,
          ],
        },
      },
    });

    // Grant permissions
    this.table.grantReadWriteData(this.chatHandler);
    llmApiKey.grantRead(this.chatHandler);
    dreamQueue.grantSendMessages(this.chatHandler);
    if (replicateApiKey) {
      replicateApiKey.grantRead(this.chatHandler);
    }
    if (webSearchApiKey) {
      webSearchApiKey.grantRead(this.chatHandler);
    }

    // Grant permissions to state table for avatar config sync
    if (stateTable) {
      stateTable.grantReadWriteData(this.chatHandler);
    }

    // Grant S3 permissions for media operations
    if (mediaBucket) {
      mediaBucket.grantReadWrite(this.chatHandler);
    }

    // Grant Twitter OAuth credentials access
    twitterAppCredentialsSecret.grantRead(this.chatHandler);

    // Grant SQS permissions for async callbacks
    responseQueue.grantSendMessages(this.chatHandler);
    chatQueue.grantSendMessages(this.chatHandler);

    // Grant secrets manager permissions for swarm secrets
    // CreateSecret needs wildcard since the secret doesn't exist yet
    this.chatHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:CreateSecret'],
      resources: ['*'],
      conditions: {
        'StringLike': {
          'secretsmanager:Name': 'swarm/*',
        },
      },
    }));

    // Other operations can use ARN pattern
    this.chatHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:UpdateSecret',
        'secretsmanager:DeleteSecret',
        'secretsmanager:PutSecretValue',
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetSecretValue',
        'secretsmanager:TagResource',
      ],
      resources: [
        `arn:aws:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:swarm/*`,
      ],
    }));

    // ListSecrets needs wildcard resource (API limitation)
    this.chatHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:ListSecrets'],
      resources: ['*'],
    }));

    // KMS permissions for Secrets Manager (AWS-managed key)
    this.chatHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'kms:Decrypt',
        'kms:GenerateDataKey',
        'kms:GenerateDataKeyWithoutPlaintext',
      ],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'kms:ViaService': `secretsmanager.${cdk.Stack.of(this).region}.amazonaws.com`,
        },
      },
    }));

    // HTTP API Gateway
    this.api = new apigateway.HttpApi(this, 'AdminApi', {
      apiName: `SwarmAdminApi-${environment}`,
      description: `API for Swarm admin interface (${environment})`,
      corsPreflight: {
        allowOrigins: allowedOrigins,
        allowMethods: [
          apigateway.CorsHttpMethod.GET,
          apigateway.CorsHttpMethod.POST,
          apigateway.CorsHttpMethod.PUT,
          apigateway.CorsHttpMethod.DELETE,
          apigateway.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Content-Type', 'Authorization', 'CF-Access-JWT-Assertion', 'Prefer', 'Idempotency-Key'],
        allowCredentials: true,
        maxAge: cdk.Duration.hours(24),
      },
    });

    // Chat Worker Lambda - processes async admin chat jobs
    const chatWorkerHandler = new nodejs.NodejsFunction(this, 'ChatWorkerHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/chat-worker.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(600),
      memorySize: 1024,
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        STATE_TABLE: stateTable?.tableName || '',
        DREAM_QUEUE_URL: dreamQueue.queueUrl,
        DREAMS_ENABLED: isProd ? 'false' : 'true',
        SECRET_PREFIX: 'swarm',
        // LLM config (worker is not API-gateway constrained)
        LLM_ENDPOINT: 'https://openrouter.ai/api/v1/chat/completions',
        LLM_MODEL: 'anthropic/claude-haiku-4.5',
        LLM_TIMEOUT_MS: '120000',
        LLM_MAX_RETRIES: '1',
        LLM_MAX_STEPS: '6',
        LLM_API_KEY_SECRET_ARN: llmApiKey.secretArn,
        WEB_SEARCH_PROVIDER: webSearchProvider || 'serpapi',
        WEB_SEARCH_API_KEY_SECRET_ARN: webSearchApiKey?.secretArn || '',
        API_DOMAIN: props.apiDomain || '',
        NODE_ENV: environment,
        // Media generation config
        MEDIA_BUCKET: mediaBucket?.bucketName || '',
        CDN_URL: cdnUrl || '',
        REPLICATE_WEBHOOK_URL: replicateWebhookUrl,
        REPLICATE_API_KEY_SECRET_ARN: replicateApiKey?.secretArn || '',
        RESPONSE_QUEUE_URL: responseQueue.queueUrl,
        // Twitter OAuth (for twitter_request_integration tool)
        TWITTER_APP_CREDENTIALS_ARN: twitterAppCredentialsSecret.secretArn,
        TWITTER_OAUTH_CALLBACK_URL: twitterOAuthCallbackUrl,
      },
      bundling: {
        externalModules: ['@aws-sdk/*', 'sharp'],
        minify: true,
        sourceMap: true,
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `mkdir -p ${outputDir}/prompts/platforms`,
            `cp -r ${inputDir}/../../../../prompts/platforms/* ${outputDir}/prompts/platforms/ 2>/dev/null || true`,
          ],
        },
      },
    });

    // Worker permissions
    this.table.grantReadWriteData(chatWorkerHandler);
    llmApiKey.grantRead(chatWorkerHandler);
    dreamQueue.grantSendMessages(chatWorkerHandler);
    if (replicateApiKey) {
      replicateApiKey.grantRead(chatWorkerHandler);
    }
    if (webSearchApiKey) {
      webSearchApiKey.grantRead(chatWorkerHandler);
    }
    if (stateTable) {
      stateTable.grantReadWriteData(chatWorkerHandler);
    }
    if (mediaBucket) {
      mediaBucket.grantReadWrite(chatWorkerHandler);
    }
    twitterAppCredentialsSecret.grantRead(chatWorkerHandler);
    responseQueue.grantSendMessages(chatWorkerHandler);

    // Secrets Manager permissions (same as chat handler)
    chatWorkerHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:CreateSecret'],
      resources: ['*'],
      conditions: {
        'StringLike': {
          'secretsmanager:Name': 'swarm/*',
        },
      },
    }));

    chatWorkerHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:UpdateSecret',
        'secretsmanager:DeleteSecret',
        'secretsmanager:PutSecretValue',
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetSecretValue',
        'secretsmanager:TagResource',
      ],
      resources: [
        `arn:aws:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:swarm/*`,
      ],
    }));

    chatWorkerHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:ListSecrets'],
      resources: ['*'],
    }));

    chatWorkerHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'kms:Decrypt',
        'kms:GenerateDataKey',
        'kms:GenerateDataKeyWithoutPlaintext',
      ],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'kms:ViaService': `secretsmanager.${cdk.Stack.of(this).region}.amazonaws.com`,
        },
      },
    }));

    chatWorkerHandler.addEventSource(new lambdaEventSources.SqsEventSource(chatQueue, {
      batchSize: 1,
      maxBatchingWindow: cdk.Duration.seconds(2),
    }));

    // Expose the API endpoint for CloudFront to use as origin
    this.apiEndpoint = this.api.apiEndpoint;

    // Update Replicate webhook URL to use raw API Gateway URL (bypasses Cloudflare Access)
    // Extract hostname from API endpoint (e.g., "https://xxx.execute-api.us-east-1.amazonaws.com")
    replicateWebhookUrl = cdk.Fn.join('', [this.api.apiEndpoint, '/webhook/replicate']);

    // Update Lambda environment variables that need the API endpoint
    // ChatHandler
    (this.chatHandler.node.defaultChild as lambda.CfnFunction).addPropertyOverride(
      'Environment.Variables.REPLICATE_WEBHOOK_URL',
      replicateWebhookUrl
    );

    // ChatWorkerHandler
    (chatWorkerHandler.node.defaultChild as lambda.CfnFunction).addPropertyOverride(
      'Environment.Variables.REPLICATE_WEBHOOK_URL',
      replicateWebhookUrl
    );

    // Add routes
    const chatIntegration = new integrations.HttpLambdaIntegration(
      'ChatIntegration',
      this.chatHandler
    );

    this.api.addRoutes({
      path: '/chat',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.POST, apigateway.HttpMethod.DELETE],
      integration: chatIntegration,
    });

      // Media conversion handler (audio/video transcoding)
      const mediaConvertHandler = new nodejs.NodejsFunction(this, 'MediaConvertHandler', {
        runtime: lambda.Runtime.NODEJS_20_X,
        entry: path.join(__dirname, '../../../admin-api/src/handlers/media-convert.ts'),
        handler: 'handler',
        timeout: cdk.Duration.seconds(60),
        memorySize: 1024,
        environment: {
          MEDIA_BUCKET: mediaBucket?.bucketName || '',
          CDN_URL: cdnUrl || '',
          NODE_ENV: environment,
        },
        bundling: {
          externalModules: ['@aws-sdk/*'],
          nodeModules: ['ffmpeg-static'],
          minify: true,
          sourceMap: true,
        },
      });

      this.mediaConvertHandler = mediaConvertHandler;

      if (mediaBucket) {
        mediaBucket.grantReadWrite(mediaConvertHandler);
      }

    // Transcribe handler - for audio transcription
    const transcribeHandler = new nodejs.NodejsFunction(this, 'TranscribeHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/transcribe.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        CF_ACCESS_TEAM_DOMAIN: cloudflareTeamDomain,
        ADMIN_EMAILS: adminEmails,
        NODE_ENV: environment,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        LLM_API_KEY_SECRET_ARN: llmApiKey.secretArn,
        INTERNAL_TEST_KEY: internalTestKey,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        nodeModules: ['ffmpeg-static'],
        minify: true,
        sourceMap: true,
      },
    });

    // Grant permissions to transcribe handler
    this.table.grantReadWriteData(transcribeHandler);
    llmApiKey.grantRead(transcribeHandler);

    const transcribeIntegration = new integrations.HttpLambdaIntegration(
      'TranscribeIntegration',
      transcribeHandler
    );

    this.api.addRoutes({
      path: '/transcribe',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: transcribeIntegration,
    });

    // Shared chat handler (public group chat)
    const sharedChatHandler = new nodejs.NodejsFunction(this, 'SharedChatHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/shared-chat.ts'),
      handler: 'handleSharedChat',
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        NODE_ENV: environment,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
    });

    this.table.grantReadWriteData(sharedChatHandler);

    const sharedChatIntegration = new integrations.HttpLambdaIntegration(
      'SharedChatIntegration',
      sharedChatHandler
    );

    this.api.addRoutes({
      path: '/shared-chat/{proxy+}',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: sharedChatIntegration,
    });

    // Avatars handler - for CRUD operations on avatars
    const avatarsHandler = new nodejs.NodejsFunction(this, 'Avatarsandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/avatars.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        STATE_TABLE: stateTable?.tableName || '',
        CF_ACCESS_TEAM_DOMAIN: cloudflareTeamDomain,
        ADMIN_EMAILS: adminEmails,
        ADMIN_WALLETS: props.adminWallets || '',
        NODE_ENV: environment,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        SECRET_PREFIX: 'swarm',
        REPLICATE_API_KEY_SECRET_ARN: replicateApiKey?.secretArn || '',
        // Internal testing (non-production only)
        INTERNAL_TEST_KEY: internalTestKey,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
    });

    // Grant permissions to avatars handler
    this.table.grantReadWriteData(avatarsHandler);
    if (stateTable) {
      stateTable.grantReadWriteData(avatarsHandler);
    }

    // Grant secrets manager permissions to avatars handler
    // CreateSecret needs wildcard since the secret doesn't exist yet
    avatarsHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:CreateSecret'],
      resources: ['*'],
      conditions: {
        'StringLike': {
          'secretsmanager:Name': 'swarm/*',
        },
      },
    }));

    avatarsHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:UpdateSecret',
        'secretsmanager:PutSecretValue',
        'secretsmanager:RestoreSecret',
        'secretsmanager:DeleteSecret',
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetSecretValue',
        'secretsmanager:TagResource',
      ],
      resources: [
        `arn:aws:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:swarm/*`,
      ],
    }));

    // ListSecrets doesn't support resource-level permissions
    avatarsHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:ListSecrets'],
      resources: ['*'],
    }));

    // KMS permissions for Secrets Manager (AWS-managed key)
    avatarsHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'kms:Decrypt',
        'kms:GenerateDataKey',
        'kms:GenerateDataKeyWithoutPlaintext',
      ],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'kms:ViaService': `secretsmanager.${cdk.Stack.of(this).region}.amazonaws.com`,
        },
      },
    }));

    (this.chatHandler.node.defaultChild as lambda.CfnFunction).addPropertyOverride(
      'Environment.Variables.MEDIA_CONVERT_FUNCTION',
      mediaConvertHandler.functionName
    );

    this.chatHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [mediaConvertHandler.functionArn],
    }));

    // CloudWatch Logs access for consolidated avatar logs
    avatarsHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:StartQuery',
        'logs:GetQueryResults',
        'logs:DescribeLogGroups',
      ],
      resources: ['*'],
    }));

    const avatarsIntegration = new integrations.HttpLambdaIntegration(
      'Avatarsntegration',
      avatarsHandler
    );

    // Avatar routes
    this.api.addRoutes({
      path: '/avatars',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.POST],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.PUT, apigateway.HttpMethod.DELETE],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/secrets',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.POST],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/integrations',
      methods: [apigateway.HttpMethod.GET],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/validate-token',
      methods: [apigateway.HttpMethod.POST],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/validate-ai-key',
      methods: [apigateway.HttpMethod.POST],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/integrations/models',
      methods: [apigateway.HttpMethod.GET],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/logs',
      methods: [apigateway.HttpMethod.GET],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/issues',
      methods: [apigateway.HttpMethod.GET],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/events',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.PATCH],
      integration: avatarsIntegration,
    });

    // Telegram diagnostics and repair routes
    this.api.addRoutes({
      path: '/avatars/{avatarId}/telegram/diagnostics',
      methods: [apigateway.HttpMethod.GET],
      integration: avatarsIntegration,
    });

    this.api.addRoutes({
      path: '/avatars/{avatarId}/telegram/repair',
      methods: [apigateway.HttpMethod.POST],
      integration: avatarsIntegration,
    });

    // Issues handler - for auto-issue tracking system (used by CI/CD, browser tests)
    const issuesHandler = new nodejs.NodejsFunction(this, 'IssuesHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/issues.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        NODE_ENV: environment,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        INTERNAL_TEST_KEY: internalTestKey,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
    });

    // Grant permissions to issues handler
    this.table.grantReadWriteData(issuesHandler);

    const issuesIntegration = new integrations.HttpLambdaIntegration(
      'IssuesIntegration',
      issuesHandler
    );

    // Issues routes
    this.api.addRoutes({
      path: '/issues',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.POST],
      integration: issuesIntegration,
    });

    this.api.addRoutes({
      path: '/issues/{issueId}',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.PATCH],
      integration: issuesIntegration,
    });

    // Health check endpoint
    const healthHandler = new nodejs.NodejsFunction(this, 'HealthHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromInline(`
        exports.handler = async () => ({
          statusCode: 200,
          body: JSON.stringify({ status: 'ok', timestamp: Date.now() }),
        });
      `),
      handler: 'index.handler',
    });

    const healthIntegration = new integrations.HttpLambdaIntegration(
      'HealthIntegration',
      healthHandler
    );

    this.api.addRoutes({
      path: '/health',
      methods: [apigateway.HttpMethod.GET],
      integration: healthIntegration,
    });

    // Jobs handler - for polling media job status
    const jobsHandler = new nodejs.NodejsFunction(this, 'JobsHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/jobs.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        CF_ACCESS_TEAM_DOMAIN: cloudflareTeamDomain,
        ADMIN_EMAILS: adminEmails,
        NODE_ENV: environment,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
    });

    // Grant permissions to jobs handler
    this.table.grantReadWriteData(jobsHandler);

    const jobsIntegration = new integrations.HttpLambdaIntegration(
      'JobsIntegration',
      jobsHandler
    );

    this.api.addRoutes({
      path: '/jobs',
      methods: [apigateway.HttpMethod.GET],
      integration: jobsIntegration,
    });

    this.api.addRoutes({
      path: '/jobs/{jobId}',
      methods: [apigateway.HttpMethod.GET],
      integration: jobsIntegration,
    });

    // Prompt Preview handler - shows what would be sent to the LLM
    const promptPreviewHandler = new nodejs.NodejsFunction(this, 'PromptPreviewHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/prompt-preview.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        CF_ACCESS_TEAM_DOMAIN: cloudflareTeamDomain,
        ADMIN_EMAILS: adminEmails,
        NODE_ENV: environment,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        INTERNAL_TEST_KEY: internalTestKey,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
    });

    // Grant permissions to prompt preview handler
    this.table.grantReadData(promptPreviewHandler);

    const promptPreviewIntegration = new integrations.HttpLambdaIntegration(
      'PromptPreviewIntegration',
      promptPreviewHandler
    );

    this.api.addRoutes({
      path: '/prompt-preview',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: promptPreviewIntegration,
    });

    // Wallet authentication handler - for Solana wallet sign-in
    const walletAuthHandler = new nodejs.NodejsFunction(this, 'WalletAuthHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/wallet-auth.ts'),
      handler: 'handleWalletAuth',
      timeout: cdk.Duration.seconds(15), // Increased for NFT verification
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        NODE_ENV: environment,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        AUTH_DOMAIN: adminDomain || 'admin.rati.chat',
        // Helius for NFT gating - pass ARN for runtime fetch instead of inline value
        HELIUS_API_KEY_ARN: heliusApiKeySecret?.secretArn || '',
        HELIUS_API_KEY: props.heliusApiKey || '',
        // Crossmint API key for JWT verification
        CROSSMINT_API_KEY_ARN: crossmintApiKey?.secretArn || '',
        // Privy configuration
        PRIVY_APP_ID: props.privyAppId || '',
        PRIVY_APP_SECRET_ARN: privyAppSecret?.secretArn || '',
        PRIVY_JWT_VERIFICATION_KEY_ARN: privyJwtVerificationKey?.secretArn || '',
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
    });

    // Grant permissions to wallet auth handler
    this.table.grantReadWriteData(walletAuthHandler);
    if (heliusApiKeySecret) {
      heliusApiKeySecret.grantRead(walletAuthHandler);
    }
    if (crossmintApiKey) {
      crossmintApiKey.grantRead(walletAuthHandler);
    }
    if (privyAppSecret) {
      privyAppSecret.grantRead(walletAuthHandler);
    }
    if (privyJwtVerificationKey) {
      privyJwtVerificationKey.grantRead(walletAuthHandler);
    }

    const walletAuthIntegration = new integrations.HttpLambdaIntegration(
      'WalletAuthIntegration',
      walletAuthHandler
    );

    // Wallet auth routes - no Cloudflare Access required
    this.api.addRoutes({
      path: '/auth/challenge',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: walletAuthIntegration,
    });

    this.api.addRoutes({
      path: '/auth/verify',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: walletAuthIntegration,
    });

    this.api.addRoutes({
      path: '/auth/me',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.OPTIONS],
      integration: walletAuthIntegration,
    });

    this.api.addRoutes({
      path: '/auth/logout',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: walletAuthIntegration,
    });

    // Wallet-link routes - link additional wallet identities to the current account
    this.api.addRoutes({
      path: '/auth/link/wallet/challenge',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: walletAuthIntegration,
    });

    this.api.addRoutes({
      path: '/auth/link/wallet/verify',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: walletAuthIntegration,
    });

    // Crossmint auth route - for email/social login via Crossmint
    this.api.addRoutes({
      path: '/auth/crossmint/verify',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: walletAuthIntegration,
    });

    // Privy auth routes - for email/social login via Privy
    this.api.addRoutes({
      path: '/auth/privy/verify',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: walletAuthIntegration,
    });

    this.api.addRoutes({
      path: '/auth/link/privy/verify',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: walletAuthIntegration,
    });

    // Inhabitation routes - for avatar claiming/abandoning
    this.api.addRoutes({
      path: '/auth/unclaimed-avatars',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.OPTIONS],
      integration: walletAuthIntegration,
    });

    this.api.addRoutes({
      path: '/auth/gate-status',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.OPTIONS],
      integration: walletAuthIntegration,
    });

    this.api.addRoutes({
      path: '/auth/inhabitation',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.OPTIONS],
      integration: walletAuthIntegration,
    });

    this.api.addRoutes({
      path: '/auth/inhabit',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: walletAuthIntegration,
    });

    this.api.addRoutes({
      path: '/auth/can-abandon',
      methods: [apigateway.HttpMethod.GET, apigateway.HttpMethod.OPTIONS],
      integration: walletAuthIntegration,
    });

    this.api.addRoutes({
      path: '/auth/abandon',
      methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.OPTIONS],
      integration: walletAuthIntegration,
    });

    // Telegram webhook handler - by default use admin-api implementation,
    // but prefer the shared @swarm/handlers multi-tenant webhook when provided.
    const telegramWebhookHandler: lambda.IFunction = props.telegramWebhookFunction ?? new nodejs.NodejsFunction(this, 'TelegramWebhookHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/telegram-webhook.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(120), // Increased for image generation
      memorySize: 512, // Increased for image processing
      environment: {
        ADMIN_TABLE: this.table.tableName,
        STATE_TABLE: stateTable?.tableName || '',
        DREAM_QUEUE_URL: dreamQueue.queueUrl,
        DREAMS_ENABLED: isProd ? 'false' : 'true',
        LLM_ENDPOINT: 'https://openrouter.ai/api/v1/chat/completions',
        LLM_MODEL: 'anthropic/claude-haiku-4.5',
        LLM_API_KEY_SECRET_ARN: llmApiKey.secretArn,
        API_DOMAIN: props.apiDomain || '',
        NODE_ENV: environment,
        // Internal test key for E2E tests (bypasses IP check in non-prod)
        INTERNAL_TEST_KEY: environment !== 'prod' ? internalTestKey : '',
        // Media generation config - REQUIRED for image/video generation
        MEDIA_BUCKET: mediaBucket?.bucketName || '',
        CDN_URL: cdnUrl || '',
        REPLICATE_WEBHOOK_URL: replicateWebhookUrl,
        REPLICATE_API_KEY_SECRET_ARN: replicateApiKey?.secretArn || '',
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            // Copy platform prompts to Lambda bundle
            `mkdir -p ${outputDir}/prompts/platforms`,
            `cp -r ${inputDir}/../../../../prompts/platforms/* ${outputDir}/prompts/platforms/ 2>/dev/null || true`,
          ],
        },
      },
    });

    if (!props.telegramWebhookFunction) {
      const fn = telegramWebhookHandler as nodejs.NodejsFunction;

      // Grant permissions to telegram handler
      this.table.grantReadWriteData(fn); // Need write for conversation history
      if (stateTable) {
        stateTable.grantReadData(fn);
      }
      llmApiKey.grantRead(fn);
      dreamQueue.grantSendMessages(fn);
      if (replicateApiKey) {
        replicateApiKey.grantRead(fn);
      }

      // Grant S3 permissions for media operations
      if (mediaBucket) {
        mediaBucket.grantReadWrite(fn);
      }

      // Grant read access to avatar secrets (bot tokens and webhook secrets)
      fn.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:*:${cdk.Stack.of(this).account}:secret:swarm/*`,
        ],
      }));

      (fn.node.defaultChild as lambda.CfnFunction).addPropertyOverride(
        'Environment.Variables.MEDIA_CONVERT_FUNCTION',
        mediaConvertHandler.functionName
      );

      fn.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: [mediaConvertHandler.functionArn],
      }));

      // Update TelegramWebhookHandler to use raw API Gateway URL for Replicate webhooks
      (fn.node.defaultChild as lambda.CfnFunction).addPropertyOverride(
        'Environment.Variables.REPLICATE_WEBHOOK_URL',
        replicateWebhookUrl
      );
    }

    // Dream worker: consumes from dreamQueue and writes dream state
    const dreamWorker = new nodejs.NodejsFunction(this, 'DreamWorkerHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/dream-worker.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      reservedConcurrentExecutions: 1,
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        STATE_TABLE: stateTable?.tableName || '',
        LLM_API_KEY_SECRET_ARN: llmApiKey.secretArn,
        // Match chat/telegram model unless overridden at runtime
        LLM_MODEL: 'anthropic/claude-haiku-4.5',
        NODE_ENV: environment,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
    });

    this.table.grantReadWriteData(dreamWorker);
    if (stateTable) {
      stateTable.grantReadWriteData(dreamWorker);
    }
    llmApiKey.grantRead(dreamWorker);
    dreamQueue.grantConsumeMessages(dreamWorker);

    // Grant Bedrock access for embeddings (used in dream memory search)
    dreamWorker.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: ['arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0'],
    }));

    // Ensure the worker processes one SQS message per invocation (avoid whole-batch retries)
    dreamWorker.addEventSource(new lambdaEventSources.SqsEventSource(dreamQueue, {
      batchSize: 1,
    }));

    const telegramIntegration = new integrations.HttpLambdaIntegration(
      'TelegramWebhookIntegration',
      telegramWebhookHandler
    );

    // Webhook route: /webhook/telegram/{avatarId}
    this.api.addRoutes({
      path: '/webhook/telegram/{avatarId}',
      methods: [apigateway.HttpMethod.POST],
      integration: telegramIntegration,
    });

    // Replicate webhook handler - for async video generation callbacks
    const replicateWebhookHandler = new nodejs.NodejsFunction(this, 'ReplicateWebhookHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/replicate-webhook.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        MEDIA_BUCKET: mediaBucket?.bucketName || '',
        CDN_URL: cdnUrl || '',
        RESPONSE_QUEUE_URL: responseQueue.queueUrl,
        NODE_ENV: environment,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
    });

    // Grant permissions to Replicate webhook handler
    this.table.grantReadWriteData(replicateWebhookHandler);
    if (mediaBucket) {
      mediaBucket.grantReadWrite(replicateWebhookHandler);
    }
    responseQueue.grantSendMessages(replicateWebhookHandler);

    const replicateIntegration = new integrations.HttpLambdaIntegration(
      'ReplicateWebhookIntegration',
      replicateWebhookHandler
    );

    // Webhook route: /webhook/replicate (with jobId query param)
    this.api.addRoutes({
      path: '/webhook/replicate',
      methods: [apigateway.HttpMethod.POST],
      integration: replicateIntegration,
    });

    // Response Sender Lambda - delivers generated media to platforms
    // Triggered by SQS messages from the Replicate webhook handler
    const responseSenderHandler = new nodejs.NodejsFunction(this, 'ResponseSenderHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/response-sender.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        NODE_ENV: environment,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
    });

    // Grant permissions to response sender
    this.table.grantReadData(responseSenderHandler);

    // Grant secrets manager access (for bot tokens)
    responseSenderHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:swarm/*`,
      ],
    }));

    // Add SQS trigger
    responseSenderHandler.addEventSource(new lambdaEventSources.SqsEventSource(responseQueue, {
      batchSize: 5,
      maxBatchingWindow: cdk.Duration.seconds(5),
    }));

    // Twitter OAuth handler - for connecting X/Twitter accounts via OAuth 1.0a
    const twitterOAuthHandler = new nodejs.NodejsFunction(this, 'TwitterOAuthHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../../admin-api/src/handlers/twitter-oauth.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ADMIN_TABLE: this.table.tableName,
        CF_ACCESS_TEAM_DOMAIN: cloudflareTeamDomain,
        ADMIN_EMAILS: adminEmails,
        NODE_ENV: environment,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
        ADMIN_UI_URL: allowedOrigins[0] || 'http://localhost:5173',
        SECRET_PREFIX: 'swarm',
        // Twitter App credentials from Secrets Manager
        TWITTER_APP_CREDENTIALS_ARN: twitterAppCredentialsSecret.secretArn,
        TWITTER_OAUTH_CALLBACK_URL: twitterOAuthCallbackUrl,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
      },
    });

    // Grant read access to Twitter app credentials
    twitterAppCredentialsSecret.grantRead(twitterOAuthHandler);

    // Grant permissions to Twitter OAuth handler
    this.table.grantReadWriteData(twitterOAuthHandler);
    if (stateTable) {
      stateTable.grantReadWriteData(twitterOAuthHandler);
    }

    // Grant Secrets Manager permissions for storing Twitter tokens
    twitterOAuthHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:CreateSecret'],
      resources: ['*'],
      conditions: {
        'StringLike': {
          'secretsmanager:Name': 'swarm/*',
        },
      },
    }));

    twitterOAuthHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:UpdateSecret',
        'secretsmanager:PutSecretValue',
        'secretsmanager:DeleteSecret',
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetSecretValue',
        'secretsmanager:TagResource',
      ],
      resources: [
        `arn:aws:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:swarm/*`,
      ],
    }));

    // KMS permissions for Secrets Manager (AWS-managed key)
    twitterOAuthHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'kms:Decrypt',
        'kms:GenerateDataKey',
        'kms:GenerateDataKeyWithoutPlaintext',
      ],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'kms:ViaService': `secretsmanager.${cdk.Stack.of(this).region}.amazonaws.com`,
        },
      },
    }));

    const twitterOAuthIntegration = new integrations.HttpLambdaIntegration(
      'TwitterOAuthIntegration',
      twitterOAuthHandler
    );

    // Twitter OAuth routes
    this.api.addRoutes({
      path: '/oauth/twitter/start',
      methods: [apigateway.HttpMethod.GET],
      integration: twitterOAuthIntegration,
    });

    this.api.addRoutes({
      path: '/oauth/twitter/callback',
      methods: [apigateway.HttpMethod.GET],
      integration: twitterOAuthIntegration,
    });

    this.api.addRoutes({
      path: '/oauth/twitter/status/{avatarId}',
      methods: [apigateway.HttpMethod.GET],
      integration: twitterOAuthIntegration,
    });

    this.api.addRoutes({
      path: '/oauth/twitter/{avatarId}',
      methods: [apigateway.HttpMethod.DELETE],
      integration: twitterOAuthIntegration,
    });

    // Configure log group prefixes for the consolidated logs endpoint
    // This allows querying logs across all admin API handlers for a given avatar
    const stackPrefix = cdk.Stack.of(this).stackName;
    avatarsHandler.addEnvironment('ADMIN_LOG_GROUPS', '');
    avatarsHandler.addEnvironment('LOG_GROUP_PREFIX', '/aws/lambda/');
    avatarsHandler.addEnvironment('ADMIN_LOG_GROUP_PREFIXES', [
      `/aws/lambda/${stackPrefix}-AdminApi`,  // All admin API handlers (chat, avatars, telegram)
    ].join(','));

    // Custom domain configuration (for Cloudflare Access proxy)
    if (props.apiDomain && props.apiCertificateArn) {
      const certificate = acm.Certificate.fromCertificateArn(
        this, 'ApiCertificate', props.apiCertificateArn
      );

      this.customDomain = new apigateway.DomainName(this, 'ApiDomain', {
        domainName: props.apiDomain,
        certificate,
      });

      new apigateway.ApiMapping(this, 'ApiMapping', {
        api: this.api,
        domainName: this.customDomain,
      });

      new cdk.CfnOutput(this, 'ApiCustomDomain', {
        value: props.apiDomain,
        description: 'Admin API custom domain',
        exportName: `swarm-admin-api-domain-${environment}`,
      });

      new cdk.CfnOutput(this, 'ApiDomainTarget', {
        value: this.customDomain.regionalDomainName,
        description: 'Target for CNAME record',
        exportName: `swarm-admin-api-target-${environment}`,
      });
    }

    // Outputs
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: props.apiDomain ? `https://${props.apiDomain}` : this.api.apiEndpoint,
      description: 'Admin API endpoint URL',
      exportName: `swarm-admin-api-url-${environment}`,
    });

    new cdk.CfnOutput(this, 'AdminTableName', {
      value: this.table.tableName,
      description: 'DynamoDB table name for admin data',
    });

  }
}
