/**
 * Shared Infrastructure Stack
 * Contains stable resources that rarely change: DynamoDB tables, S3 bucket, CDN, Lambda layer
 * This stack is deployed first and exports resources for other stacks
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
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
  public readonly cdnUrl?: string;
  public readonly cdnDistributionId?: string;
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
    } = props;
    const suffix = nameSuffix ?? '';

    if (useExistingResources) {
      // Import/export compatibility: legacy monolithic stack exports these names.
      this.stateTableName = cdk.Fn.importValue(`swarm-state-table-${environment}${suffix}`);
      this.activityTableName = cdk.Fn.importValue(`swarm-activity-table-${environment}${suffix}`);
      this.mediaBucketName = cdk.Fn.importValue(`swarm-media-bucket-${environment}${suffix}`);

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

      // Prefer importing CDN URL from legacy exports.
      this.cdnUrl = enableCdn ? cdk.Fn.importValue(`swarm-cdn-url-${environment}${suffix}`) : undefined;
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
    } else {
      // Create shared infrastructure
      this.shared = new SharedInfrastructure(this, 'Shared', {
        environment,
        nameSuffix,
        enableCdn,
        cdnDomain: galleryDomain,
        cdnCertificateArn: galleryCertificateArn,
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
      this.discordClusterArn = this.shared.discordCluster.clusterArn;
      this.discordClusterName = this.shared.discordCluster.clusterName;
    }

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
  }
}
