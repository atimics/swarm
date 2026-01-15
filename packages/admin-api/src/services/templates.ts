/**
 * Agent Templates Service - Import/Export agent configurations
 */
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import type { AgentRecord, UserSession } from '../types.js';
import * as agentsDefault from './agents.js';

/**
 * Dependencies interface for template service (for testing)
 */
export interface TemplateServiceDeps {
  dynamoClient: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send: (command: any) => Promise<any>;
  };
  agentService: {
    createAgent: (name: string, session: UserSession, description?: string) => Promise<AgentRecord>;
  };
  tableName: string;
}

// Default dependencies
const defaultDynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

const defaultDeps: TemplateServiceDeps = {
  dynamoClient: defaultDynamoClient,
  agentService: agentsDefault,
  tableName: ADMIN_TABLE,
};

export interface AgentTemplate {
  templateId: string;
  name: string;
  description: string;
  config: Partial<AgentRecord>;
  createdAt: number;
}

/**
 * List all available agent templates
 */
export async function listTemplates(deps: TemplateServiceDeps = defaultDeps): Promise<AgentTemplate[]> {
  const result = await deps.dynamoClient.send(new ScanCommand({
    TableName: deps.tableName,
    FilterExpression: 'sk = :sk',
    ExpressionAttributeValues: {
      ':sk': 'TEMPLATE',
    },
  })) as { Items?: AgentTemplate[] };

  return result.Items || [];
}

/**
 * Get a template by ID
 */
export async function getTemplate(templateId: string, deps: TemplateServiceDeps = defaultDeps): Promise<AgentTemplate | null> {
  const result = await deps.dynamoClient.send(new GetCommand({
    TableName: deps.tableName,
    Key: {
      pk: `TEMPLATE#${templateId}`,
      sk: 'TEMPLATE',
    },
  })) as { Item?: AgentTemplate };

  return result.Item || null;
}

/**
 * Export an existing agent as a template
 */
export async function exportAgentAsTemplate(
  agent: AgentRecord,
  templateName: string,
  description: string,
  deps: TemplateServiceDeps = defaultDeps
): Promise<AgentTemplate> {
  const templateId = `tpl-${agent.agentId}-${Date.now().toString(36)}`;

  const template: AgentTemplate = {
    templateId,
    name: templateName,
    description,
    config: {
      name: agent.name,
      description: agent.description,
      persona: agent.persona,
      platforms: agent.platforms,
      llmConfig: agent.llmConfig,
      voiceConfig: agent.voiceConfig,
      mediaConfig: agent.mediaConfig,
    },
    createdAt: Date.now(),
  };

  await deps.dynamoClient.send(new PutCommand({
    TableName: deps.tableName,
    Item: {
      pk: `TEMPLATE#${templateId}`,
      sk: 'TEMPLATE',
      ...template,
    },
  }));

  return template;
}

/**
 * Create a new agent from a template
 */
export async function createAgentFromTemplate(
  templateId: string,
  session: UserSession,
  agentName?: string,
  deps: TemplateServiceDeps = defaultDeps
): Promise<AgentRecord> {
  const template = await getTemplate(templateId, deps);
  if (!template) {
    throw new Error(`Template not found: ${templateId}`);
  }

  const name = agentName || template.name;
  const agent = await deps.agentService.createAgent(name, session, template.description);

  // Update with template config
  // Note: we don't overwrite ID, status, timestamps etc.
  const { name: _, description: __, ...configToApply } = template.config;

  // We can't use updateAgent directly because it requires a session
  // But we have createAgent which already saved it.
  // To keep it simple, we'll just merge the template config into the new agent.

  const mergedAgent: AgentRecord = {
    ...agent,
    ...configToApply,
    name, // Restore name if overwritten by configToApply accidentally
    updatedAt: Date.now(),
  };

  await deps.dynamoClient.send(new PutCommand({
    TableName: deps.tableName,
    Item: mergedAgent,
  }));

  return mergedAgent;
}
