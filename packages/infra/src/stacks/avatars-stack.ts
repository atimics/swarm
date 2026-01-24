/**
 * Avatars Stack
 * Contains avatar-specific resources and config seeding
 * This stack is optional and handles avatar deployment
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { Construct } from 'constructs';
import { AvatarConstruct } from '../constructs/avatar.js';
import type { SharedInfraStack } from './shared-infra-stack.js';
import type { AdminApiStack } from './admin-api-stack.js';
import type { AvatarConfig } from '@swarm/core';

type DynamoAttributeValue =
  | { S: string }
  | { N: string }
  | { BOOL: boolean }
  | { NULL: true }
  | { L: DynamoAttributeValue[] }
  | { M: Record<string, DynamoAttributeValue> };

function toDynamoAttributeValue(value: unknown): DynamoAttributeValue {
  if (value === null) return { NULL: true };
  if (value === undefined) return { NULL: true };

  if (typeof value === 'string') return { S: value };
  if (typeof value === 'number') return { N: String(value) };
  if (typeof value === 'boolean') return { BOOL: value };

  if (Array.isArray(value)) {
    return {
      L: value
        .filter(v => v !== undefined)
        .map(v => toDynamoAttributeValue(v)),
    };
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([key, v]) => [key, toDynamoAttributeValue(v)] as const);
    return { M: Object.fromEntries(entries) };
  }

  return { S: String(value) };
}

export interface AvatarsStackProps extends cdk.StackProps {
  /**
   * Environment name (dev, staging, prod)
   */
  environment: string;
  /**
   * Optional suffix for resource names/exports (e.g., "-a1b2c3")
   */
  nameSuffix?: string;

  /**
   * Reference to the shared infrastructure stack
   */
  sharedInfraStack: SharedInfraStack;

  /**
   * Reference to the Admin API stack (optional)
   */
  adminApiStack?: AdminApiStack;

  /**
   * Path to avatars directory
   */
  avatarsPath: string;

  /**
   * Path to compiled handlers
   */
  handlersPath: string;

  /**
   * Specific avatars to deploy (default: all)
   */
  avatarIds?: string[];

  /**
   * Replicate API key secret ARN
   */
  replicateApiKeyArn?: string;
  /**
   * Secrets Manager prefix (e.g., "swarm" or "swarm-abcdef")
   */
  secretPrefix?: string;
}

export class AvatarsStack extends cdk.Stack {
  public readonly avatars: Map<string, AvatarConstruct> = new Map();

  constructor(scope: Construct, id: string, props: AvatarsStackProps) {
    super(scope, id, props);

    const {
      environment,
      nameSuffix,
      sharedInfraStack,
      adminApiStack,
      avatarsPath,
      handlersPath,
      avatarIds: requestedAvatarIds,
      replicateApiKeyArn,
      secretPrefix,
    } = props;

    // Import shared resources
    const stateTable = dynamodb.Table.fromTableAttributes(this, 'StateTable', {
      tableArn: sharedInfraStack.stateTableArn,
      tableName: sharedInfraStack.stateTableName,
      globalIndexes: ['gsi1'],
    });

    const activityTable = dynamodb.Table.fromTableAttributes(this, 'ActivityTable', {
      tableArn: sharedInfraStack.activityTableArn,
      tableName: sharedInfraStack.activityTableName,
    });

    const mediaBucket = s3.Bucket.fromBucketAttributes(this, 'MediaBucket', {
      bucketArn: sharedInfraStack.mediaBucketArn,
      bucketName: sharedInfraStack.mediaBucketName,
    });

    const dependencyLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      'DependencyLayer',
      sharedInfraStack.dependencyLayerArn
    );

    // Look up default VPC for ECS cluster
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });
    const discordCluster = ecs.Cluster.fromClusterAttributes(this, 'DiscordCluster', {
      clusterArn: sharedInfraStack.discordClusterArn,
      clusterName: sharedInfraStack.discordClusterName,
      vpc,
      securityGroups: [],
    });

    // Skip if avatars directory doesn't exist
    if (!fs.existsSync(avatarsPath)) {
      console.log(`Avatars directory not found at ${avatarsPath}, skipping avatar deployment`);
      return;
    }

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

      config.id = avatarId;

      const personaPath = path.join(avatarsPath, avatarId, 'persona.md');
      if (fs.existsSync(personaPath)) {
        config.persona = fs.readFileSync(personaPath, 'utf-8');
      }

      const avatar = new AvatarConstruct(this, `Avatar-${avatarId}`, {
        config,
        stateTable,
        activityTable,
        mediaBucket,
        dependencyLayer,
        handlersCodePath: handlersPath,
        cdnUrl: sharedInfraStack.cdnUrl,
        environment,
        nameSuffix,
        secretPrefix,
        discordCluster,
        replicateApiKeyArn,
        mediaConvertFunction: adminApiStack?.adminApi?.mediaConvertHandler,
      });

      // Seed CONFIG into DynamoDB (won't overwrite admin-synced configs)
      new cr.AwsCustomResource(this, `SeedAvatarConfig-${avatarId}`, {
        onCreate: {
          service: 'DynamoDB',
          action: 'updateItem',
          parameters: {
            TableName: stateTable.tableName,
            Key: {
              pk: { S: `AVATAR#${avatarId}` },
              sk: { S: 'CONFIG' },
            },
            UpdateExpression: 'SET #config = if_not_exists(#config, :config)',
            ExpressionAttributeNames: {
              '#config': 'config',
            },
            ExpressionAttributeValues: {
              ':config': toDynamoAttributeValue(config),
            },
          },
          physicalResourceId: cr.PhysicalResourceId.of(`SeedAvatarConfig-${environment}-${avatarId}`),
        },
        onUpdate: {
          service: 'DynamoDB',
          action: 'updateItem',
          parameters: {
            TableName: stateTable.tableName,
            Key: {
              pk: { S: `AVATAR#${avatarId}` },
              sk: { S: 'CONFIG' },
            },
            UpdateExpression: 'SET #config = if_not_exists(#config, :config)',
            ExpressionAttributeNames: {
              '#config': 'config',
            },
            ExpressionAttributeValues: {
              ':config': toDynamoAttributeValue(config),
            },
          },
          physicalResourceId: cr.PhysicalResourceId.of(`SeedAvatarConfig-${environment}-${avatarId}`),
        },
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: [stateTable.tableArn],
        }),
      });

      this.avatars.set(avatarId, avatar);
    }

    // Output
    new cdk.CfnOutput(this, 'AvatarCount', {
      value: String(this.avatars.size),
      description: 'Number of avatars deployed',
    });
  }
}
