/**
 * Shared Handlers Construct
 *
 * Deploys a shared (multi-tenant) runtime based on @swarm/handlers:
 * - Shared FIFO message/response/media queues
 * - Message processor + response sender + media processor consumers
 * - Shared Twitter mention poller schedule (multi-tenant)
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface SharedHandlersProps {
  environment: string;
  /**
   * Optional dependency layer for native modules like sharp.
   * When using NodejsFunction bundling, this is only needed for native deps.
   */
  dependencyLayer?: lambda.ILayerVersion;
  stateTable: dynamodb.ITable;
  activityTable: dynamodb.ITable;
  mediaBucket: s3.IBucket;
  cdnUrl?: string;
  replicateApiKeyArn?: string;
  secretPrefix?: string;
  /**
   * Twitter API tier: 'free' (100 tweets/month) or 'basic' (15,000 tweets/month)
   * @default 'basic'
   */
  twitterApiTier?: 'free' | 'basic';
  /**
   * Override the monthly Twitter API budget (reads)
   * @default tier default (100 for free, 15000 for basic)
   */
  twitterMonthlyBudget?: number;
  /**
   * Percentage of daily budget to reserve for spikes (0-100)
   * @default 20
   */
  twitterDailyReservePct?: number;
  /**
   * Internal test key for bypassing webhook auth in non-production environments.
   * If not provided, one will be generated.
   */
  internalTestKey?: string;
}

export class SharedHandlers extends Construct {
  public readonly messageQueue: sqs.Queue;
  public readonly responseQueue: sqs.Queue;
  public readonly mediaQueue: sqs.Queue;
  public readonly telegramWebhook: lambda.Function;

  constructor(scope: Construct, id: string, props: SharedHandlersProps) {
    super(scope, id);

    const {
      environment,
      dependencyLayer,
      stateTable,
      activityTable,
      mediaBucket,
      cdnUrl,
      replicateApiKeyArn,
      secretPrefix = 'swarm',
      twitterApiTier = 'basic',
      twitterMonthlyBudget,
      twitterDailyReservePct = 20,
      internalTestKey,
    } = props;

    // Generate internal test key if not provided (non-production only)
    const effectiveInternalTestKey = environment !== 'prod' && environment !== 'production'
      ? internalTestKey || process.env.INTERNAL_TEST_KEY || `test-${Date.now()}-${Math.random().toString(36).substring(2)}`
      : '';

    // Path to handlers source files
    const handlersEntry = path.join(__dirname, '../../../handlers/src');

    const dlq = new sqs.Queue(this, 'DeadLetterQueue', {
      queueName: `swarm-${environment}-dlq.fifo`,
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.messageQueue = new sqs.Queue(this, 'MessageQueue', {
      queueName: `swarm-${environment}-messages.fifo`,
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    this.responseQueue = new sqs.Queue(this, 'ResponseQueue', {
      queueName: `swarm-${environment}-responses.fifo`,
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    this.mediaQueue = new sqs.Queue(this, 'MediaQueue', {
      queueName: `swarm-${environment}-media.fifo`,
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.minutes(5),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    stateTable.grantReadWriteData(lambdaRole);
    activityTable.grantReadWriteData(lambdaRole);
    mediaBucket.grantReadWrite(lambdaRole);
    this.messageQueue.grantSendMessages(lambdaRole);
    this.messageQueue.grantConsumeMessages(lambdaRole);
    this.responseQueue.grantSendMessages(lambdaRole);
    this.responseQueue.grantConsumeMessages(lambdaRole);
    this.mediaQueue.grantSendMessages(lambdaRole);
    this.mediaQueue.grantConsumeMessages(lambdaRole);

    // Secrets: allow reading any secret under the configured prefix (e.g. swarm/<avatarId>/secrets)
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:${secretPrefix}/*`,
      ],
    }));

    // KMS: allow decrypting secrets (required for KMS-encrypted secrets)
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'kms:ViaService': `secretsmanager.${cdk.Aws.REGION}.amazonaws.com`,
        },
      },
    }));

    if (replicateApiKeyArn) {
      lambdaRole.addToPolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [replicateApiKeyArn],
      }));
    }

    // Grant Bedrock access (used by core LLM service if configured)
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['*'],
    }));

    const commonEnv: Record<string, string> = {
      NODE_OPTIONS: '--enable-source-maps',
      STATE_TABLE: stateTable.tableName,
      ACTIVITY_TABLE: activityTable.tableName,
      MEDIA_BUCKET: mediaBucket.bucketName,
      MESSAGE_QUEUE_URL: this.messageQueue.queueUrl,
      RESPONSE_QUEUE_URL: this.responseQueue.queueUrl,
      MEDIA_QUEUE_URL: this.mediaQueue.queueUrl,
      CDN_URL: cdnUrl || '',
      ENVIRONMENT: environment,
      SECRET_PREFIX: secretPrefix,
      // Twitter API budget configuration
      TWITTER_API_TIER: twitterApiTier,
      TWITTER_DAILY_RESERVE_PCT: String(twitterDailyReservePct),
      ...(twitterMonthlyBudget ? { TWITTER_MONTHLY_BUDGET: String(twitterMonthlyBudget) } : {}),
      // Enable unified MessageProcessor for consistent tool access across platforms
      USE_UNIFIED_PROCESSOR: 'true',
      // Internal test key for bypassing webhook auth in E2E tests
      ...(effectiveInternalTestKey ? { INTERNAL_TEST_KEY: effectiveInternalTestKey } : {}),
    };

    if (replicateApiKeyArn) {
      commonEnv.REPLICATE_API_KEY_SECRET_ARN = replicateApiKeyArn;
    }

    // Common bundling options: bundle AWS SDK (don't externalize) to avoid layer CJS/ESM conflicts
    // Externalize sharp (native layer). node-fetch is bundled since openai package requires it.
    const bundlingOptions = {
      externalModules: ['sharp'],
      minify: true,
      sourceMap: true,
    };

    const messageProcessor = new nodejs.NodejsFunction(this, 'MessageProcessor', {
      functionName: `swarm-${environment}-message-processor`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(handlersEntry, 'message-processor.ts'),
      handler: 'handler',
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(60),
      memorySize: 1024,
      environment: commonEnv,
      bundling: bundlingOptions,
    });

    this.telegramWebhook = new nodejs.NodejsFunction(this, 'TelegramWebhookShared', {
      functionName: `swarm-${environment}-telegram-webhook`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(handlersEntry, 'telegram-webhook-shared.ts'),
      handler: 'handler',
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: commonEnv,
      bundling: bundlingOptions,
    });

    messageProcessor.addEventSource(new lambdaEventSources.SqsEventSource(this.messageQueue, {
      batchSize: 10,
      reportBatchItemFailures: true,
    }));

    const responseSender = new nodejs.NodejsFunction(this, 'ResponseSender', {
      functionName: `swarm-${environment}-response-sender`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(handlersEntry, 'response-sender.ts'),
      handler: 'handler',
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(60),
      memorySize: 1024,
      environment: commonEnv,
      bundling: bundlingOptions,
    });

    responseSender.addEventSource(new lambdaEventSources.SqsEventSource(this.responseQueue, {
      batchSize: 10,
      reportBatchItemFailures: true,
    }));

    const mediaProcessor = new nodejs.NodejsFunction(this, 'MediaProcessor', {
      functionName: `swarm-${environment}-media-processor`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(handlersEntry, 'media-processor.ts'),
      handler: 'handler',
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      role: lambdaRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: commonEnv,
      bundling: bundlingOptions,
    });

    mediaProcessor.addEventSource(new lambdaEventSources.SqsEventSource(this.mediaQueue, {
      batchSize: 5,
      reportBatchItemFailures: true,
    }));

    const twitterMentionPoller = new nodejs.NodejsFunction(this, 'TwitterMentionPollerShared', {
      functionName: `swarm-${environment}-twitter-mention-poller`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(handlersEntry, 'twitter-mention-poller-shared.ts'),
      handler: 'handler',
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      role: lambdaRole,
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      environment: commonEnv,
      bundling: bundlingOptions,
    });

    new events.Rule(this, 'TwitterMentionPollSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(twitterMentionPoller)],
    });

    // Autonomous Tweet Poster - runs hourly, manages per-avatar timing internally
    // Each avatar has 4-6 hour randomized intervals configured in their autonomousPosts settings
    const autonomousTweetPoster = new nodejs.NodejsFunction(this, 'AutonomousTweetPoster', {
      functionName: `swarm-${environment}-autonomous-tweet-poster`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(handlersEntry, 'autonomous-tweet-poster.ts'),
      handler: 'handler',
      layers: dependencyLayer ? [dependencyLayer] : undefined,
      role: lambdaRole,
      timeout: cdk.Duration.minutes(5), // Longer timeout for multi-avatar processing
      memorySize: 1024,
      environment: commonEnv,
      bundling: bundlingOptions,
    });

    new events.Rule(this, 'AutonomousTweetSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.LambdaFunction(autonomousTweetPoster)],
    });
  }
}
