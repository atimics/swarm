/**
 * Avatar Construct
 * CDK construct for a single swarm avatar with all its resources
 */
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import type { AvatarConfig } from '@swarm/core';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface AvatarConstructProps {
  /**
   * Avatar configuration
   */
  config: AvatarConfig;

  /**
   * Shared state table (multi-tenant)
   */
  stateTable: dynamodb.ITable;

  /**
   * Shared activity table
   */
  activityTable: dynamodb.ITable;

  /**
   * Shared media bucket
   */
  mediaBucket: s3.IBucket;

  /**
   * Lambda layer with dependencies
   */
  dependencyLayer: lambda.ILayerVersion;

  /**
   * Path to compiled handlers code
   */
  handlersCodePath: string;

  /**
   * ARN of secrets (or will create)
   */
  secretsArn?: string;

  /**
   * Environment (dev, staging, prod)
   */
  environment?: string;
  /**
   * Optional suffix for resource names/exports (e.g., "-a1b2c3")
   */
  nameSuffix?: string;

  /**
   * CDN URL for media (e.g., https://gallery.example.com)
   */
  cdnUrl?: string;

  /**
   * ECS cluster for Discord gateway workers (optional)
   */
  discordCluster?: ecs.ICluster;

  /**
   * Optional shared Replicate API key secret ARN.
   * When provided, runtime handlers can fall back to this if the per-avatar secrets
   * JSON does not include Replicate credentials.
   */
  replicateApiKeyArn?: string;
  /**
   * Secrets Manager prefix (e.g., "swarm" or "swarm-abcdef")
   */
  secretPrefix?: string;

  /**
   * Optional shared media conversion Lambda (ffmpeg) used for audio/video transcoding.
   * When provided, avatar runtime lambdas can invoke it (e.g., to produce Telegram-friendly OGG/Opus).
   */
  mediaConvertFunction?: lambda.IFunction;
}

export class AvatarConstruct extends Construct {
  public readonly messageQueue: sqs.Queue;
  public readonly responseQueue: sqs.Queue;
  public readonly mediaQueue: sqs.Queue;
  public readonly api: apigateway.RestApi;
  public readonly secrets: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: AvatarConstructProps) {
    super(scope, id);

    const {
      config,
      stateTable,
      activityTable,
      mediaBucket,
      dependencyLayer,
      handlersCodePath,
      environment = 'dev',
      nameSuffix,
      secretPrefix,
      cdnUrl,
      discordCluster,
      replicateApiKeyArn,
      mediaConvertFunction,
    } = props;
    const suffix = nameSuffix ?? '';
    const secretsPrefix = secretPrefix ?? 'swarm';

    // Create or import secrets
    if (props.secretsArn) {
      this.secrets = secretsmanager.Secret.fromSecretCompleteArn(this, 'Secrets', props.secretsArn);
    } else {
      this.secrets = new secretsmanager.Secret(this, 'Secrets', {
        secretName: `${secretsPrefix}/${config.id}/secrets`,
        description: `Secrets for avatar ${config.name}`,
      });
    }

    // Create SQS queues with DLQ
    const dlq = new sqs.Queue(this, 'DeadLetterQueue', {
      queueName: `${config.id}${suffix}-dlq.fifo`,
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.messageQueue = new sqs.Queue(this, 'MessageQueue', {
      queueName: `${config.id}${suffix}-messages.fifo`,
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    this.responseQueue = new sqs.Queue(this, 'ResponseQueue', {
      queueName: `${config.id}${suffix}-responses.fifo`,
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    this.mediaQueue = new sqs.Queue(this, 'MediaQueue', {
      queueName: `${config.id}${suffix}-media.fifo`,
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.minutes(5),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    // Common Lambda environment
    const commonEnv: Record<string, string> = {
      NODE_OPTIONS: '--enable-source-maps',
      AVATAR_ID: config.id,
      AVATAR_NAME: config.name,
      SECRET_PREFIX: secretsPrefix,
      STATE_TABLE: stateTable.tableName,
      ACTIVITY_TABLE: activityTable.tableName,
      MEDIA_BUCKET: mediaBucket.bucketName,
      SECRETS_ARN: this.secrets.secretArn,
      MESSAGE_QUEUE_URL: this.messageQueue.queueUrl,
      RESPONSE_QUEUE_URL: this.responseQueue.queueUrl,
      MEDIA_QUEUE_URL: this.mediaQueue.queueUrl,
      CDN_URL: cdnUrl || '',
      ENVIRONMENT: environment,
    };

    if (mediaConvertFunction) {
      commonEnv.MEDIA_CONVERT_FUNCTION = mediaConvertFunction.functionName;
    }

    if (replicateApiKeyArn) {
      commonEnv.REPLICATE_API_KEY_SECRET_ARN = replicateApiKeyArn;
    }

    // Lambda role
    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Grant permissions
    stateTable.grantReadWriteData(lambdaRole);
    activityTable.grantReadWriteData(lambdaRole);
    mediaBucket.grantReadWrite(lambdaRole);
    this.secrets.grantRead(lambdaRole);

    if (replicateApiKeyArn) {
      const replicateSecret = secretsmanager.Secret.fromSecretCompleteArn(this, 'ReplicateApiKey', replicateApiKeyArn);
      replicateSecret.grantRead(lambdaRole);
    }
    this.messageQueue.grantSendMessages(lambdaRole);
    this.messageQueue.grantConsumeMessages(lambdaRole);
    this.responseQueue.grantSendMessages(lambdaRole);
    this.responseQueue.grantConsumeMessages(lambdaRole);
    this.mediaQueue.grantSendMessages(lambdaRole);
    this.mediaQueue.grantConsumeMessages(lambdaRole);

    // Grant Bedrock access
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: ['*'],
    }));

    if (mediaConvertFunction) {
      lambdaRole.addToPolicy(new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [mediaConvertFunction.functionArn],
      }));
    }

    // Create API Gateway
    this.api = new apigateway.RestApi(this, 'Api', {
      restApiName: `${config.id}-api`,
      description: `API for avatar ${config.name}`,
      deployOptions: {
        stageName: environment,
      },
      defaultCorsPreflightOptions: config.platforms.web?.corsOrigins ? {
        allowOrigins: config.platforms.web.corsOrigins,
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization', 'X-Wallet-Address', 'X-Wallet-Signature'],
      } : undefined,
    });

    // Telegram ingress is handled by the shared multi-tenant webhook (Admin API route).
    // Per-avatar Telegram webhooks are deprecated and no longer provisioned here.

    // Discord interactions webhook handler
    if (config.platforms.discord?.enabled) {
      const discordHandler = new lambda.Function(this, 'DiscordWebhook', {
        functionName: `${config.id}${suffix}-discord-webhook`,
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'discord-webhook.handler',
        code: lambda.Code.fromAsset(handlersCodePath),
        layers: [dependencyLayer],
        role: lambdaRole,
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        environment: commonEnv,
      });

      const discordResource = this.api.root.addResource('webhook').addResource('discord').addResource(config.id);
      discordResource.addMethod('POST', new apigateway.LambdaIntegration(discordHandler));
    }

    // Web chat handler
    if (config.platforms.web?.enabled) {
      const webHandler = new lambda.Function(this, 'WebChat', {
        functionName: `${config.id}${suffix}-web-chat`,
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'web-chat.handler',
        code: lambda.Code.fromAsset(handlersCodePath),
        layers: [dependencyLayer],
        role: lambdaRole,
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        environment: commonEnv,
      });

      const chatResource = this.api.root.addResource('chat');
      chatResource.addMethod('POST', new apigateway.LambdaIntegration(webHandler));
    }

    // Message processor (SQS triggered)
    const messageProcessor = new lambda.Function(this, 'MessageProcessor', {
      functionName: `${config.id}${suffix}-message-processor`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'message-processor.handler',
      code: lambda.Code.fromAsset(handlersCodePath),
      layers: [dependencyLayer],
      role: lambdaRole,
      timeout: cdk.Duration.seconds(60),
      memorySize: 1024,
      environment: commonEnv,
    });

    messageProcessor.addEventSource(new lambdaEventSources.SqsEventSource(this.messageQueue, {
      batchSize: 1,
    }));

    // Response sender (SQS triggered)
    const responseSender = new lambda.Function(this, 'ResponseSender', {
      functionName: `${config.id}${suffix}-response-sender`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'response-sender.handler',
      code: lambda.Code.fromAsset(handlersCodePath),
      layers: [dependencyLayer],
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: commonEnv,
    });

    responseSender.addEventSource(new lambdaEventSources.SqsEventSource(this.responseQueue, {
      batchSize: 1,
    }));

    // Media processor (SQS triggered)
    const mediaProcessor = new lambda.Function(this, 'MediaProcessor', {
      functionName: `${config.id}${suffix}-media-processor`,
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
      batchSize: 1,
    }));

    // Discord gateway worker (Fargate) for full bot ingestion
    if (config.platforms.discord?.enabled
      && config.platforms.discord.mode !== 'webhook'
      && (config.platforms.discord.useGateway ?? true)) {
      if (!discordCluster) {
        console.warn(`Discord gateway requested for ${config.id}, but no ECS cluster provided`);
      } else {
        const gatewayImage = new ecrAssets.DockerImageAsset(this, 'DiscordGatewayImage', {
          directory: path.resolve(__dirname, '../../../..'),
          file: 'packages/handlers/Dockerfile.discord-gateway',
        });

        const logGroup = new logs.LogGroup(this, 'DiscordGatewayLogs', {
          logGroupName: `/aws/ecs/${config.id}${suffix}-discord-gateway`,
          retention: logs.RetentionDays.ONE_WEEK,
        });

        const taskDefinition = new ecs.FargateTaskDefinition(this, 'DiscordGatewayTask', {
          cpu: 256,
          memoryLimitMiB: 512,
        });

        taskDefinition.addContainer('DiscordGateway', {
          image: ecs.ContainerImage.fromDockerImageAsset(gatewayImage),
          logging: ecs.LogDrivers.awsLogs({
            logGroup,
            streamPrefix: `${config.id}-discord`,
          }),
          environment: {
            AVATAR_ID: config.id,
            AVATAR_NAME: config.name,
            STATE_TABLE: stateTable.tableName,
            ACTIVITY_TABLE: activityTable.tableName,
            MESSAGE_QUEUE_URL: this.messageQueue.queueUrl,
            SECRETS_ARN: this.secrets.secretArn,
            DISCORD_GATEWAY_INTENTS: String(config.platforms.discord.intents || ''),
            ENVIRONMENT: environment,
          },
        });

        stateTable.grantReadWriteData(taskDefinition.taskRole);
        activityTable.grantReadWriteData(taskDefinition.taskRole);
        this.secrets.grantRead(taskDefinition.taskRole);
        this.messageQueue.grantSendMessages(taskDefinition.taskRole);

        new ecs.FargateService(this, 'DiscordGatewayService', {
          cluster: discordCluster,
          taskDefinition,
          desiredCount: 1,
          assignPublicIp: true,
        });
      }
    }

    const alarmPrefix = `${config.id}-${environment}`;

    // Queue depth alarms
    new cloudwatch.Alarm(this, 'MessageQueueDepthAlarm', {
      alarmName: `${alarmPrefix}-messages-queue-depth`,
      metric: this.messageQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'ResponseQueueDepthAlarm', {
      alarmName: `${alarmPrefix}-responses-queue-depth`,
      metric: this.responseQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'MediaQueueDepthAlarm', {
      alarmName: `${alarmPrefix}-media-queue-depth`,
      metric: this.mediaQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // DLQ alarms
    new cloudwatch.Alarm(this, 'DlqDepthAlarm', {
      alarmName: `${alarmPrefix}-dlq-depth`,
      metric: dlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'DlqAgeAlarm', {
      alarmName: `${alarmPrefix}-dlq-age`,
      metric: dlq.metricApproximateAgeOfOldestMessage({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 300,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Lambda error alarms
    new cloudwatch.Alarm(this, 'MessageProcessorErrorsAlarm', {
      alarmName: `${alarmPrefix}-message-processor-errors`,
      metric: messageProcessor.metricErrors({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'ResponseSenderErrorsAlarm', {
      alarmName: `${alarmPrefix}-response-sender-errors`,
      metric: responseSender.metricErrors({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'MediaProcessorErrorsAlarm', {
      alarmName: `${alarmPrefix}-media-processor-errors`,
      metric: mediaProcessor.metricErrors({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Scheduled tweet poster
    const scheduledTweet = config.scheduling.tweets?.[0];
    if (config.platforms.twitter?.enabled && scheduledTweet) {
      const tweetPoster = new lambda.Function(this, 'TweetPoster', {
        functionName: `${config.id}${suffix}-tweet-poster`,
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'tweet-poster.handler',
        code: lambda.Code.fromAsset(handlersCodePath),
        layers: [dependencyLayer],
        role: lambdaRole,
        timeout: cdk.Duration.minutes(2),
        memorySize: 512,
        environment: {
          ...commonEnv,
          TWEET_TEMPLATE: scheduledTweet.template || 'general',
        },
      });

      // Schedule rule - parse cron string or use default
      const cronParts = scheduledTweet.cron?.split(' ') || [];
      new events.Rule(this, 'TweetSchedule', {
        schedule: cronParts.length >= 5
          ? (() => {
              const minute = cronParts[0] || '0';
              const hour = cronParts[1] || '12';
              const day = cronParts[2] || '*';
              const month = cronParts[3] || '*';
              const weekDay = cronParts[4] || '?';

              // CDK validation: cannot supply both `day` and `weekDay`.
              // EventBridge cron requires one of them to be '?' when the other is used.
              const base: events.CronOptions = { minute, hour, month };
              const cronOptions: events.CronOptions =
                day !== '?' ? { ...base, day } :
                weekDay !== '?' ? { ...base, weekDay } :
                { ...base, day: '*' };

              return events.Schedule.cron(cronOptions);
            })()
          : events.Schedule.cron({
              hour: '12,18',
              minute: '0',
            }),
        targets: [new targets.LambdaFunction(tweetPoster)],
      });
    }



    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: `API URL for avatar ${config.name}`,
    });
  }
}
