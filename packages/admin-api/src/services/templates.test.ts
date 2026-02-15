/**
 * Template Service Tests
 * Tests template import/export with dependency injection
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  exportAvatarAsTemplate,
  listTemplates,
  createAvatarFromTemplate,
  type TemplateServiceDeps,
} from './templates.js';
import type { AvatarRecord, UserSession } from '../types.js';

// Helper to create mock deps
function createMockDeps(): TemplateServiceDeps {
  const mockSend = vi.fn(() => Promise.resolve({}));
  const mockCreateAvatar = vi.fn((name: string, _session: UserSession, desc?: string) =>
    Promise.resolve({
      pk: 'AVATAR#new-avatar',
      sk: 'CONFIG',
      avatarId: 'new-avatar',
      name,
      description: desc,
      status: 'draft',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy: 'test@example.com',
    } as AvatarRecord)
  );

  return {
    dynamoClient: {
      send: mockSend as unknown as TemplateServiceDeps['dynamoClient']['send'],
    },
    avatarService: {
      createAvatar: mockCreateAvatar as unknown as TemplateServiceDeps['avatarService']['createAvatar'],
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

  describe('exportAvatarAsTemplate', () => {
    it('returns template metadata + config', async () => {
      const avatar: AvatarRecord = {
        pk: 'AVATAR#avatar-1',
        sk: 'CONFIG',
        avatarId: 'avatar-1',
        name: 'Avatar One',
        description: 'Test avatar',
        persona: 'You are a test avatar',
        platforms: { telegram: { enabled: true } },
        llmConfig: { provider: 'openai', model: 'gpt-4', temperature: 0.7, maxTokens: 1000, useGlobalKey: true },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: 'test@example.com',
      };

      const template = await exportAvatarAsTemplate(avatar, 'Test Template', 'Template Description', mockDeps);

      expect(template.name).toBe('Test Template');
      expect(template.description).toBe('Template Description');
      expect(template.config.persona).toBe(avatar.persona);
      expect(template.config.llmConfig?.model).toBe('gpt-4');
      expect(template.templateId).toContain('tpl-avatar-1');
      expect(mockDeps.dynamoClient.send).toHaveBeenCalled();
    });

    it('stores template with correct pk/sk', async () => {
      const avatar: AvatarRecord = {
        pk: 'AVATAR#avatar-1',
        sk: 'CONFIG',
        avatarId: 'avatar-1',
        name: 'Test Avatar',
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: 'test@example.com',
      };

      let capturedCommand: unknown;
      (mockDeps.dynamoClient.send as ReturnType<typeof vi.fn>).mockImplementation((cmd) => {
        capturedCommand = cmd;
        return Promise.resolve({});
      });

      await exportAvatarAsTemplate(avatar, 'Template', 'Desc', mockDeps);

      expect(capturedCommand).toBeDefined();
      const putCmd = capturedCommand as { input?: { Item?: { sk?: string } }; Item?: { sk?: string } };
      // The PutCommand wraps input
      const item = putCmd.Item || putCmd.input?.Item;
      expect(item?.sk).toBe('TEMPLATE');
    });
  });

  describe('listTemplates', () => {
    it('returns stored templates', async () => {
      (mockDeps.dynamoClient.send as ReturnType<typeof vi.fn>).mockImplementation(() =>
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
      (mockDeps.dynamoClient.send as ReturnType<typeof vi.fn>).mockImplementation(() =>
        Promise.resolve({ Items: [] })
      );

      const templates = await listTemplates(mockDeps);
      expect(templates).toHaveLength(0);
    });
  });

  describe('createAvatarFromTemplate', () => {
    it('creates an avatar from template', async () => {
      let callCount = 0;
      (mockDeps.dynamoClient.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
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
        // PutCommand for merged avatar
        return Promise.resolve({});
      });

      const avatar = await createAvatarFromTemplate('t1', session, 'Custom Name', mockDeps);

      expect(avatar.name).toBe('Custom Name');
      expect(avatar.persona).toBe('From template');
      expect(avatar.llmConfig?.model).toBe('gpt-X');
      expect(mockDeps.avatarService.createAvatar).toHaveBeenCalled();
    });

    it('uses template name when avatarName not provided', async () => {
      let callCount = 0;
      (mockDeps.dynamoClient.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
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

      const avatar = await createAvatarFromTemplate('t1', session, undefined, mockDeps);

      expect(avatar.name).toBe('Default Template Name');
    });

    it('throws error when template not found', async () => {
      (mockDeps.dynamoClient.send as ReturnType<typeof vi.fn>).mockImplementation(() =>
        Promise.resolve({ Item: undefined })
      );

      await expect(createAvatarFromTemplate('nonexistent', session, undefined, mockDeps)).rejects.toThrow(
        'Template not found: nonexistent'
      );
    });
  });
});
