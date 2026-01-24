/**
 * Shared Infrastructure Stack
 * Contains stable resources that rarely change: DynamoDB tables, S3 bucket, CDN, Lambda layer
 * This stack is deployed first and exports resources for other stacks
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { SharedInfrastructure } from '../constructs/shared.js';

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
}

export class SharedInfraStack extends cdk.Stack {
  public readonly shared: SharedInfrastructure;

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

    const { environment, enableCdn = true, galleryDomain, galleryCertificateArn, nameSuffix } = props;
    const suffix = nameSuffix ?? '';

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
