/**
 * Profile Tools Tests
 *
 * Tests for profile and persona management tools.
 */
import { describe, it, expect } from 'vitest';
import { createProfileTools, type ProfileServices } from './profile.js';

const mockProfileServices: ProfileServices = {
  updateProfile: async (_avatarId: string, updates: any) => {
    return { ...updates };
  },

  setProfileImage: async (_avatarId: string, _imageUrl: string) => {
    return { success: true };
  },

  getProfileUploadUrl: async () => ({
    uploadUrl: 'https://example.com/upload',
    publicUrl: 'https://example.com/image.jpg',
  }),

  saveUploadedProfileImage: async (_avatarId: string, publicUrl: string) => ({
    url: publicUrl,
  }),

  setCharacterReference: async (_avatarId: string, _imageUrl: string, _description?: string) => {
    return { success: true };
  },

  getCharacterReferenceUploadUrl: async () => ({
    uploadUrl: 'https://example.com/upload-ref',
    publicUrl: 'https://example.com/reference.jpg',
  }),

  saveUploadedCharacterReference: async (_avatarId: string, publicUrl: string, _description?: string) => ({
    url: publicUrl,
  }),
};

describe('Profile Tools - update_my_profile', () => {
  it('updates profile with new values', async () => {
    const tools = createProfileTools(mockProfileServices);
    const tool = tools.find(t => t.name === 'update_my_profile');
    expect(tool).toBeDefined();

    const result = await (tool!.execute as any)(
      {
        name: 'New Name',
        description: 'Updated description',
      },
      { avatarId: 'test', platform: 'admin-ui' }
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
  });

  it('allows partial updates', () => {
    const tools = createProfileTools(mockProfileServices);
    const tool = tools.find(t => t.name === 'update_my_profile');

    const onlyName = tool!.inputSchema.safeParse({
      name: 'New Name',
    });
    const onlyDescription = tool!.inputSchema.safeParse({
      description: 'New description',
    });

    expect(onlyName.success).toBe(true);
    expect(onlyDescription.success).toBe(true);
  });

  it('accepts persona updates', () => {
    const tools = createProfileTools(mockProfileServices);
    const tool = tools.find(t => t.name === 'update_my_profile');

    const withPersona = tool!.inputSchema.safeParse({
      persona: 'You are a creative AI',
    });

    expect(withPersona.success).toBe(true);
  });

  it('has profile category', () => {
    const tools = createProfileTools(mockProfileServices);
    const tool = tools.find(t => t.name === 'update_my_profile');

    expect(tool?.category).toBe('profile');
  });

  it('is only available on admin-ui and api platforms', () => {
    const tools = createProfileTools(mockProfileServices);
    const tool = tools.find(t => t.name === 'update_my_profile');

    expect(tool?.platforms).toEqual(['admin-ui', 'api']);
  });
});

describe('Profile Tools - set_profile_image', () => {
  it('exists as a tool', () => {
    const tools = createProfileTools(mockProfileServices);
    const tool = tools.find(t => t.name === 'set_profile_image');
    expect(tool).toBeDefined();
    expect(tool?.category).toBe('profile');
  });

  it('has profile category', () => {
    const tools = createProfileTools(mockProfileServices);
    const tool = tools.find(t => t.name === 'set_profile_image');

    expect(tool?.category).toBe('profile');
  });
});

describe('Profile Tools - set_character_reference', () => {
  it('exists as a tool', () => {
    const tools = createProfileTools(mockProfileServices);
    const tool = tools.find(t => t.name === 'set_character_reference');
    expect(tool).toBeDefined();
  });

  it('has profile category', () => {
    const tools = createProfileTools(mockProfileServices);
    const tool = tools.find(t => t.name === 'set_character_reference');

    expect(tool?.category).toBe('profile');
  });
});

describe('Profile Tools - Service Interface', () => {
  it('creates tools with valid service interface', () => {
    const tools = createProfileTools(mockProfileServices);

    expect(tools.length).toBeGreaterThan(0);
    tools.forEach(tool => {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    });
  });

  it('all profile tools have profile category', () => {
    const tools = createProfileTools(mockProfileServices);
    const profileTools = tools.filter(t => t.category === 'profile');

    expect(profileTools.length).toBe(tools.length);
  });
});
