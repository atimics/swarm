/**
 * Shared Infrastructure Stack
 * Contains stable resources that rarely change: DynamoDB tables, S3 bucket, CDN, Lambda layer
 * This stack is deployed first and exports resources for other stacks
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SharedInfrastructure } from '../constructs/shared.js';
import { computeDependencyLayerAssetHash } from '../utils/layer-asset-hash.js';

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface SharedInfraStackProps extends cdk.StackProps {
  /**
   * Environment name (dev, staging, prod)
   */
  environment: string;
  /**
   * Optional suffix for resource names/exports (e.g., "-a1b2c3")
   */
  nameSuffix?: string;

  /**
   * Enable CloudFront CDN
   */
  enableCdn?: boolean;

  /**
   * Custom domain for gallery CDN (e.g., 'gallery.rati.chat')
   */
  galleryDomain?: string;

  /**
   * ACM certificate ARN for gallery CDN (must be in us-east-1)
   */
  galleryCertificateArn?: string;

  /**
   * Adopt existing shared resources instead of creating them.
   *
   * Use this when migrating from the legacy monolithic stack to split stacks in an account
   * where the shared tables/bucket/cluster already exist.
   */
  useExistingResources?: boolean;

  /**
   * Optional: explicitly provide an existing dependency layer version ARN.
   * If omitted and useExistingResources is true, SharedInfraStack will create a new layer
   * with a non-colliding name.
   */
  existingDependencyLayerArn?: string;

  /**
   * Optional: explicitly provide an existing CloudFront distribution ID.
   * If omitted and useExistingResources is true, cdnDistributionId will be left undefined.
   */
  existingCdnDistributionId?: string;

  /**
   * Email address for CloudWatch alarm notifications.
   * When provided, an email subscription is added to the alarm SNS topic.
   */
  alarmNotificationEmail?: string;
}

export class SharedInfraStack extends cdk.Stack {
  public readonly shared?: SharedInfrastructure;

  // Cross-stack references (exported via CloudFormation)
  public readonly stateTableArn: string;
  public readonly stateTableName: string;
  public readonly activityTableArn: string;
  public readonly activityTableName: string;
  public readonly mediaBucketArn: string;
  public readonly mediaBucketName: string;
  public readonly dependencyLayerArn: string;
  /**
   * SSM parameter name for the dependency layer ARN.
   * Consumer stacks should use this via SSM lookup to avoid CloudFormation export conflicts.
   */
  public readonly dependencyLayerArnParamName: string;
  public readonly cdnUrl?: string;
  public readonly cdnDistributionId?: string;
  public readonly alarmTopicArn: string;
  public readonly discordClusterArn: string;
  public readonly discordClusterName: string;

  constructor(scope: Construct, id: string, props: SharedInfraStackProps) {
    super(scope, id, props);

    const {
      environment,
      enableCdn = true,
      galleryDomain,
      galleryCertificateArn,
      nameSuffix,
      useExistingResources = false,
      existingDependencyLayerArn,
      existingCdnDistributionId,
      alarmNotificationEmail,
    } = props;
    const suffix = nameSuffix ?? '';

    // SSM parameter name for dependency layer ARN - consistent across all code paths
    this.dependencyLayerArnParamName = `/swarm/${environment}${suffix}/dependency-layer-arn`;

    if (useExistingResources) {
      // IMPORTANT: when adopting existing shared resources, do NOT depend on CloudFormation exports.
      // Exports cannot be updated/removed while imported by another stack, which causes deployment
      // deadlocks during migrations and prevents safely deleting the legacy monolithic stack.
      // These shared resource names are stable and deterministic (see SharedInfrastructure).
      this.stateTableName = `swarm-state-${environment}${suffix}`;
      this.activityTableName = `swarm-activity-${environment}${suffix}`;
      this.mediaBucketName = `swarm-media-${environment}${suffix}-${cdk.Aws.ACCOUNT_ID}`;

      // Derive ARNs from imported names.
      this.stateTableArn = cdk.Stack.of(this).formatArn({
        service: 'dynamodb',
        resource: 'table',
        resourceName: this.stateTableName,
      });
      this.activityTableArn = cdk.Stack.of(this).formatArn({
        service: 'dynamodb',
        resource: 'table',
        resourceName: this.activityTableName,
      });
      this.mediaBucketArn = cdk.Arn.format(
        {
          partition: cdk.Stack.of(this).partition,
          service: 's3',
          region: '',
          account: '',
          resource: this.mediaBucketName,
        },
        this
      );

      this.discordClusterName = `swarm-discord-${environment}${suffix}`;
      this.discordClusterArn = cdk.Stack.of(this).formatArn({
        service: 'ecs',
        resource: 'cluster',
        resourceName: this.discordClusterName,
      });

      // CDN URL is derived from the configured galleryDomain when present.
      // (Avoid importing legacy exports; distributionId can be provided explicitly if needed.)
      this.cdnUrl = enableCdn && galleryDomain ? `https://${galleryDomain}` : undefined;
      this.cdnDistributionId = existingCdnDistributionId;

      // Dependency layer: either import an explicit version ARN or create a new layer with a unique name.
      if (existingDependencyLayerArn) {
        this.dependencyLayerArn = existingDependencyLayerArn;
      } else {
        const layerPath = path.resolve(__dirname, '../../../layer');
        const layer = new lambda.LayerVersion(this, 'DependencyLayer', {
          layerVersionName: `swarm-deps-${environment}${suffix}-split`,
          description: 'Shared dependencies for swarm handlers (split-stack migration layer)',
          compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
          code: lambda.Code.fromAsset(layerPath, {
            assetHash: computeDependencyLayerAssetHash(layerPath),
          }),
        });
        this.dependencyLayerArn = layer.layerVersionArn;
      }

      // SNS alarm topic (created even in migration mode for new alarm wiring)
      const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
        topicName: `swarm-alarms-${environment}${suffix}`,
        displayName: `Swarm Alarms (${environment})`,
      });
      if (alarmNotificationEmail) {
        alarmTopic.addSubscription(
          new snsSubscriptions.EmailSubscription(alarmNotificationEmail)
        );
      }
      this.alarmTopicArn = alarmTopic.topicArn;
    } else {
      // Create shared infrastructure
      this.shared = new SharedInfrastructure(this, 'Shared', {
        environment,
        nameSuffix,
        enableCdn,
        cdnDomain: galleryDomain,
        cdnCertificateArn: galleryCertificateArn,
        alarmNotificationEmail,
      });

      // Store references for cross-stack access
      this.stateTableArn = this.shared.stateTable.tableArn;
      this.stateTableName = this.shared.stateTable.tableName;
      this.activityTableArn = this.shared.activityTable.tableArn;
      this.activityTableName = this.shared.activityTable.tableName;
      this.mediaBucketArn = this.shared.mediaBucket.bucketArn;
      this.mediaBucketName = this.shared.mediaBucket.bucketName;
      this.dependencyLayerArn = this.shared.dependencyLayer.layerVersionArn;
      this.cdnUrl = this.shared.cdnUrl;
      this.cdnDistributionId = this.shared.distribution?.distributionId;
      this.alarmTopicArn = this.shared.alarmTopic.topicArn;
      this.discordClusterArn = this.shared.discordCluster.clusterArn;
      this.discordClusterName = this.shared.discordCluster.clusterName;
    }

    // Store dependency layer ARN in SSM to allow updates without breaking cross-stack refs.
    // CloudFormation exports fail to update when imported by another stack, but SSM parameters
    // can be updated freely.
    new ssm.StringParameter(this, 'DependencyLayerArnParam', {
      parameterName: this.dependencyLayerArnParamName,
      stringValue: this.dependencyLayerArn,
      description: 'Dependency layer ARN for swarm handlers',
    });

    // MIGRATION BRIDGE: Maintain the old CDK implicit export while consumer stacks migrate to SSM.
    // This prevents "export in use" errors during the first deployment after switching to SSM.
    // We use the exact same logical ID as CDK's auto-generated output so CloudFormation sees
    // it as an update (no-op) rather than a delete+create.
    // Once all consumer stacks are deployed with SSM lookups, this can be removed.
    const legacyExport = new cdk.CfnOutput(this, 'LegacyLayerExport', {
      value: this.dependencyLayerArn,
      exportName: `${this.stackName}:ExportsOutputRefDependencyLayerE4A0C25129DFB32E`,
      description: 'Legacy export for migration - will be removed after all stacks use SSM',
    });
    // Override the logical ID to match the old auto-generated one
    legacyExport.overrideLogicalId('ExportsOutputRefDependencyLayerE4A0C25129DFB32E');

    // Export values for cross-stack references
    new cdk.CfnOutput(this, 'StateTableArnExport', {
      value: this.stateTableArn,
      exportName: `swarm-state-table-arn-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'StateTableNameExport', {
      value: this.stateTableName,
      exportName: `swarm-state-table-name-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'ActivityTableArnExport', {
      value: this.activityTableArn,
      exportName: `swarm-activity-table-arn-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'MediaBucketArnExport', {
      value: this.mediaBucketArn,
      exportName: `swarm-media-bucket-arn-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'MediaBucketNameExport', {
      value: this.mediaBucketName,
      exportName: `swarm-media-bucket-name-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'DependencyLayerArnExport', {
      value: this.dependencyLayerArn,
      exportName: `swarm-dependency-layer-arn-${environment}${suffix}`,
    });

    if (this.cdnDistributionId) {
      new cdk.CfnOutput(this, 'CdnDistributionIdExport', {
        value: this.cdnDistributionId,
        exportName: `swarm-cdn-distribution-id-${environment}${suffix}`,
      });
    }

    new cdk.CfnOutput(this, 'DiscordClusterArnExport', {
      value: this.discordClusterArn,
      exportName: `swarm-discord-cluster-arn-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'AlarmTopicArnExport', {
      value: this.alarmTopicArn,
      exportName: `swarm-alarm-topic-arn-${environment}${suffix}`,
    });
  }
}
