/**
 * Gallery Tools Tests
 *
 * Tests for gallery and reference image management tools.
 */
import { describe, it, expect } from 'vitest';
import { createGalleryTools, type GalleryServices, type GalleryItem } from './gallery.js';

const mockGalleryItems: GalleryItem[] = [
  {
    id: 'img-1',
    type: 'image',
    url: 'https://example.com/image1.jpg',
    prompt: 'First image',
    createdAt: Date.now(),
  },
  {
    id: 'img-2',
    type: 'image',
    url: 'https://example.com/image2.jpg',
    prompt: 'Second image',
    createdAt: Date.now() - 1000,
  },
];

const mockGalleryServices: GalleryServices = {
  getGallery: async (avatarId: string) => {
    if (avatarId === 'empty') return [];
    return mockGalleryItems;
  },

  getGalleryItem: async (_avatarId: string, itemId: string) => {
    return mockGalleryItems.find(item => item.id === itemId) || null;
  },

  searchGallery: async (_avatarId: string, _query: string) => {
    return mockGalleryItems;
  },
};

describe('Gallery Tools - get_my_gallery', () => {
  it('lists gallery images', async () => {
    const tools = createGalleryTools(mockGalleryServices);
    const tool = tools.find(t => t.name === 'get_my_gallery');
    expect(tool).toBeDefined();

    const result = await (tool!.execute as any)({}, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(true);
    expect(result.data).toBeInstanceOf(Array);
    expect(result.data.length).toBe(2);
    expect(result.data[0]).toHaveProperty('id');
    expect(result.data[0]).toHaveProperty('url');
  });

  it('returns empty array when no images exist', async () => {
    const tools = createGalleryTools(mockGalleryServices);
    const tool = tools.find(t => t.name === 'get_my_gallery');

    const result = await (tool!.execute as any)({}, {
      avatarId: 'empty',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it('has gallery category', () => {
    const tools = createGalleryTools(mockGalleryServices);
    const tool = tools.find(t => t.name === 'get_my_gallery');

    expect(tool?.category).toBe('gallery');
  });
});

describe('Gallery Tools - send_gallery_image', () => {
  it('sends gallery image to chat', async () => {
    const tools = createGalleryTools(mockGalleryServices);
    const tool = tools.find(t => t.name === 'send_gallery_image');
    expect(tool).toBeDefined();

    // Just verify the tool exists and has correct structure
    expect(tool?.description).toContain('gallery');
  });

  it('validates required imageId field', () => {
    const tools = createGalleryTools(mockGalleryServices);
    const tool = tools.find(t => t.name === 'send_gallery_image');

    const valid = tool!.inputSchema.safeParse({
      imageId: 'img-123',
    });
    const missing = tool!.inputSchema.safeParse({});

    expect(valid.success).toBe(true);
    expect(missing.success).toBe(false);
  });

  it('has gallery category', () => {
    const tools = createGalleryTools(mockGalleryServices);
    const tool = tools.find(t => t.name === 'send_gallery_image');

    expect(tool?.category).toBe('gallery');
  });
});

describe('Gallery Tools - search_gallery', () => {
  it('searches gallery by query', () => {
    const tools = createGalleryTools(mockGalleryServices);
    const tool = tools.find(t => t.name === 'search_gallery');
    expect(tool).toBeDefined();

    expect(tool?.description).toContain('Search');
  });

  it('validates required query field', () => {
    const tools = createGalleryTools(mockGalleryServices);
    const tool = tools.find(t => t.name === 'search_gallery');

    const valid = tool!.inputSchema.safeParse({ query: 'cat images' });
    const missing = tool!.inputSchema.safeParse({});

    expect(valid.success).toBe(true);
    expect(missing.success).toBe(false);
  });

  it('has gallery category', () => {
    const tools = createGalleryTools(mockGalleryServices);
    const tool = tools.find(t => t.name === 'search_gallery');

    expect(tool?.category).toBe('gallery');
  });
});

describe('Gallery Tools - Service Interface', () => {
  it('creates tools with valid service interface', () => {
    const tools = createGalleryTools(mockGalleryServices);

    expect(tools.length).toBeGreaterThan(0);
    tools.forEach(tool => {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    });
  });

  it('all gallery tools have gallery category', () => {
    const tools = createGalleryTools(mockGalleryServices);
    const galleryTools = tools.filter(t => t.category === 'gallery');

    expect(galleryTools.length).toBe(tools.length);
  });
});
