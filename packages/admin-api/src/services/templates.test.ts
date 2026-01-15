/**
 * Template Service Tests
 * Tests template import/export with dependency injection
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
  exportAgentAsTemplate,
  listTemplates,
  createAgentFromTemplate,
  type TemplateServiceDeps,
} from './templates.js';
import type { AgentRecord, UserSession } from '../types.js';

// Helper to create mock deps
function createMockDeps(): TemplateServiceDeps {
  const mockSend = mock(() => Promise.resolve({}));
  const mockCreateAgent = mock((name: string, _session: UserSession, desc?: string) =>
    Promise.resolve({
      pk: 'AGENT#new-agent',
      sk: 'CONFIG',
      agentId: 'new-agent',
      name,
      description: desc,
      status: 'draft',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy: 'test@example.com',
    } as AgentRecord)
  );

  return {
    dynamoClient: {
      send: mockSend as unknown as TemplateServiceDeps['dynamoClient']['send'],
    },
    agentService: {
      createAgent: mockCreateAgent as unknown as TemplateServiceDeps['agentService']['createAgent'],
    },
    tableName: 'test-admin-table',
  };
}

// Helper to create test session
function createTestSession(): UserSession {
  return {
    email: 'admin@example.com',
    userId: 'user-123',
    isAdmin: true,
    accessToken: 'test-token',
  };
}

describe('TemplateService', () => {
  let mockDeps: TemplateServiceDeps;
  const session = createTestSession();

  beforeEach(() => {
    mockDeps = createMockDeps();
  });

  describe('exportAgentAsTemplate', () => {
    it('returns template metadata + config', async () => {
      const agent: AgentRecord = {
        pk: 'AGENT#agent-1',
        sk: 'CONFIG',
        agentId: 'agent-1',
        name: 'Agent One',
        description: 'Test agent',
        persona: 'You are a test agent',
        platforms: { telegram: { enabled: true } },
        llmConfig: { provider: 'openai', model: 'gpt-4', temperature: 0.7, maxTokens: 1000, useGlobalKey: true },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: 'test@example.com',
      };

      const template = await exportAgentAsTemplate(agent, 'Test Template', 'Template Description', mockDeps);

      expect(template.name).toBe('Test Template');
      expect(template.description).toBe('Template Description');
      expect(template.config.persona).toBe(agent.persona);
      expect(template.config.llmConfig?.model).toBe('gpt-4');
      expect(template.templateId).toContain('tpl-agent-1');
      expect(mockDeps.dynamoClient.send).toHaveBeenCalled();
    });

    it('stores template with correct pk/sk', async () => {
      const agent: AgentRecord = {
        pk: 'AGENT#agent-1',
        sk: 'CONFIG',
        agentId: 'agent-1',
        name: 'Test Agent',
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: 'test@example.com',
      };

      let capturedCommand: unknown;
      (mockDeps.dynamoClient.send as ReturnType<typeof mock>).mockImplementation((cmd) => {
        capturedCommand = cmd;
        return Promise.resolve({});
      });

      await exportAgentAsTemplate(agent, 'Template', 'Desc', mockDeps);

      expect(capturedCommand).toBeDefined();
      const putCmd = capturedCommand as { input?: { Item?: { sk?: string } }; Item?: { sk?: string } };
      // The PutCommand wraps input
      const item = putCmd.Item || putCmd.input?.Item;
      expect(item?.sk).toBe('TEMPLATE');
    });
  });

  describe('listTemplates', () => {
    it('returns stored templates', async () => {
      (mockDeps.dynamoClient.send as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve({
          Items: [
            { templateId: 't1', name: 'T1', config: {}, description: 'Desc 1', createdAt: 1000 },
            { templateId: 't2', name: 'T2', config: {}, description: 'Desc 2', createdAt: 2000 },
          ],
        })
      );

      const templates = await listTemplates(mockDeps);

      expect(templates).toHaveLength(2);
      expect(templates[0].templateId).toBe('t1');
      expect(templates[1].name).toBe('T2');
    });

    it('returns empty array when no templates', async () => {
      (mockDeps.dynamoClient.send as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve({ Items: [] })
      );

      const templates = await listTemplates(mockDeps);
      expect(templates).toHaveLength(0);
    });
  });

  describe('createAgentFromTemplate', () => {
    it('creates an agent from template', async () => {
      let callCount = 0;
      (mockDeps.dynamoClient.send as ReturnType<typeof mock>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // GetCommand for template
          return Promise.resolve({
            Item: {
              templateId: 't1',
              name: 'Template Name',
              description: 'Template description',
              config: { persona: 'From template', llmConfig: { model: 'gpt-X' } },
              createdAt: 1000,
            },
          });
        }
        // PutCommand for merged agent
        return Promise.resolve({});
      });

      const agent = await createAgentFromTemplate('t1', session, 'Custom Name', mockDeps);

      expect(agent.name).toBe('Custom Name');
      expect(agent.persona).toBe('From template');
      expect(agent.llmConfig?.model).toBe('gpt-X');
      expect(mockDeps.agentService.createAgent).toHaveBeenCalled();
    });

    it('uses template name when agentName not provided', async () => {
      let callCount = 0;
      (mockDeps.dynamoClient.send as ReturnType<typeof mock>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            Item: {
              templateId: 't1',
              name: 'Default Template Name',
              description: 'Description',
              config: {},
              createdAt: 1000,
            },
          });
        }
        return Promise.resolve({});
      });

      const agent = await createAgentFromTemplate('t1', session, undefined, mockDeps);

      expect(agent.name).toBe('Default Template Name');
    });

    it('throws error when template not found', async () => {
      (mockDeps.dynamoClient.send as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.resolve({ Item: undefined })
      );

      await expect(createAgentFromTemplate('nonexistent', session, undefined, mockDeps)).rejects.toThrow(
        'Template not found: nonexistent'
      );
    });
  });
});
