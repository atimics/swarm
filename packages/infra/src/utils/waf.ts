import { Construct } from 'constructs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

export interface CreateManagedWebAclProps {
  scope: 'CLOUDFRONT' | 'REGIONAL';
  name: string;
  metricPrefix: string;
  rateLimit?: number;
}

function sanitizeMetricName(value: string): string {
  const trimmed = value.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-');
  if (!trimmed) return 'swarm-waf';
  return trimmed.slice(0, 128);
}

function createVisibilityConfig(metricName: string): wafv2.CfnWebACL.VisibilityConfigProperty {
  return {
    cloudWatchMetricsEnabled: true,
    sampledRequestsEnabled: true,
    metricName: sanitizeMetricName(metricName),
  };
}

export function createManagedWebAcl(
  scope: Construct,
  id: string,
  props: CreateManagedWebAclProps
): wafv2.CfnWebACL {
  const rateLimit = props.rateLimit ?? 2000;
  const ruleMetricPrefix = sanitizeMetricName(props.metricPrefix);

  return new wafv2.CfnWebACL(scope, id, {
    name: props.name,
    scope: props.scope,
    defaultAction: { allow: {} },
    visibilityConfig: createVisibilityConfig(`${ruleMetricPrefix}-webacl`),
    rules: [
      {
        name: 'AWSManagedIpReputation',
        priority: 0,
        overrideAction: { none: {} },
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesAmazonIpReputationList',
          },
        },
        visibilityConfig: createVisibilityConfig(`${ruleMetricPrefix}-ipreputation`),
      },
      {
        name: 'IpRateLimit',
        priority: 1,
        action: { block: {} },
        statement: {
          rateBasedStatement: {
            aggregateKeyType: 'IP',
            limit: rateLimit,
          },
        },
        visibilityConfig: createVisibilityConfig(`${ruleMetricPrefix}-ratelimit`),
      },
    ],
  });
}

