/**
 * MCP Configuration Service
 *
 * Manages MCP server configuration (toolsets and external servers) for agents.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { McpConfig, ToolsetId, ExternalMcpServer } from '../types.js';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

/**
 * Get MCP configuration for an agent
 */
export async function getMcpConfig(agentId: string): Promise<McpConfig | null> {
  const result = await dynamoClient.send(
    new GetCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `AGENT#${agentId}`,
        sk: 'CONFIG',
      },
      ProjectionExpression: 'mcpConfig',
    })
  );

  if (!result.Item) {
    return null;
  }

  return result.Item.mcpConfig || {
    enabledToolsets: [],
    externalServers: [],
  };
}

/**
 * Update MCP configuration for an agent
 */
export async function updateMcpConfig(
  agentId: string,
  config: McpConfig,
  updatedBy: string
): Promise<void> {
  await dynamoClient.send(
    new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `AGENT#${agentId}`,
        sk: 'CONFIG',
      },
      UpdateExpression: 'SET mcpConfig = :config, updatedAt = :now, updatedBy = :by',
      ExpressionAttributeValues: {
        ':config': config,
        ':now': Date.now(),
        ':by': updatedBy,
      },
    })
  );
}

/**
 * Check if a toolset is enabled for an agent
 */
export async function isToolsetEnabled(
  agentId: string,
  toolsetId: ToolsetId
): Promise<boolean> {
  // Core is always enabled
  if (toolsetId === 'core') {
    return true;
  }

  const config = await getMcpConfig(agentId);
  if (!config) {
    return false;
  }

  return config.enabledToolsets.includes(toolsetId);
}

/**
 * Get all enabled toolsets for an agent
 */
export async function getEnabledToolsets(agentId: string): Promise<ToolsetId[]> {
  const config = await getMcpConfig(agentId);
  if (!config) {
    return ['core']; // Core is always enabled
  }

  // Ensure core is always included
  const toolsets = new Set(config.enabledToolsets);
  toolsets.add('core');
  return Array.from(toolsets) as ToolsetId[];
}

/**
 * Get all enabled external MCP servers for an agent
 */
export async function getEnabledExternalServers(
  agentId: string
): Promise<ExternalMcpServer[]> {
  const config = await getMcpConfig(agentId);
  if (!config) {
    return [];
  }

  return config.externalServers.filter((s) => s.enabled);
}

/**
 * Create MCP admin services for tool registration
 */
export function createMcpAdminServices() {
  return {
    getMcpConfig,
    updateMcpConfig,
  };
}
