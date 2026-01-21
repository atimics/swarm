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
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as s3 from 'aws-cdk-lib/aws-s3';

export interface SharedHandlersProps {
  environment: string;
  handlersCodePath: string;
  dependencyLayer: lambda.ILayerVersion;
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
      handlersCodePath,
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
    } = props;

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
    };

    if (replicateApiKeyArn) {
      commonEnv.REPLICATE_API_KEY_SECRET_ARN = replicateApiKeyArn;
    }

    const messageProcessor = new lambda.Function(this, 'MessageProcessor', {
      functionName: `swarm-${environment}-message-processor`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'message-processor.handler',
      code: lambda.Code.fromAsset(handlersCodePath),
      layers: [dependencyLayer],
      role: lambdaRole,
      timeout: cdk.Duration.seconds(60),
      memorySize: 1024,
      environment: commonEnv,
    });

    this.telegramWebhook = new lambda.Function(this, 'TelegramWebhookShared', {
      functionName: `swarm-${environment}-telegram-webhook`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'telegram-webhook-shared.handler',
      code: lambda.Code.fromAsset(handlersCodePath),
      layers: [dependencyLayer],
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: commonEnv,
    });

    messageProcessor.addEventSource(new lambdaEventSources.SqsEventSource(this.messageQueue, {
      batchSize: 10,
      reportBatchItemFailures: true,
    }));

    const responseSender = new lambda.Function(this, 'ResponseSender', {
      functionName: `swarm-${environment}-response-sender`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'response-sender.handler',
      code: lambda.Code.fromAsset(handlersCodePath),
      layers: [dependencyLayer],
      role: lambdaRole,
      timeout: cdk.Duration.seconds(60),
      memorySize: 1024,
      environment: commonEnv,
    });

    responseSender.addEventSource(new lambdaEventSources.SqsEventSource(this.responseQueue, {
      batchSize: 10,
      reportBatchItemFailures: true,
    }));

    const mediaProcessor = new lambda.Function(this, 'MediaProcessor', {
      functionName: `swarm-${environment}-media-processor`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'media-processor.handler',
      code: lambda.Code.fromAsset(handlersCodePath),
      layers: [dependencyLayer],
      role: lambdaRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: commonEnv,
    });

    mediaProcessor.addEventSource(new lambdaEventSources.SqsEventSource(this.mediaQueue, {
      batchSize: 5,
      reportBatchItemFailures: true,
    }));

    const twitterMentionPoller = new lambda.Function(this, 'TwitterMentionPollerShared', {
      functionName: `swarm-${environment}-twitter-mention-poller`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'twitter-mention-poller-shared.handler',
      code: lambda.Code.fromAsset(handlersCodePath),
      layers: [dependencyLayer],
      role: lambdaRole,
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      environment: commonEnv,
    });

    new events.Rule(this, 'TwitterMentionPollSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(twitterMentionPoller)],
    });
  }
}
