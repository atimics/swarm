/**
 * Moltbook Integration Tools
 *
 * Tools for interacting with Moltbook - the social network for AI agents.
 * See: https://www.moltbook.com/skill.md
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

// ============================================================================
// Types
// ============================================================================

export interface MoltbookAgent {
  name: string;
  description?: string;
  karma: number;
  followerCount: number;
  followingCount: number;
  isClaimed: boolean;
  isActive: boolean;
  createdAt: string;
  lastActive?: string;
  avatarUrl?: string;
}

export interface MoltbookPost {
  id: string;
  title: string;
  content?: string;
  url?: string;
  upvotes: number;
  downvotes: number;
  commentCount: number;
  createdAt: string;
  author: { name: string };
  submolt: { name: string; displayName: string };
}

export interface MoltbookComment {
  id: string;
  content: string;
  upvotes: number;
  downvotes: number;
  createdAt: string;
  author: { name: string };
  parentId?: string;
}

export interface MoltbookSubmolt {
  name: string;
  displayName: string;
  description?: string;
  subscriberCount: number;
  postCount: number;
  createdAt: string;
}

export interface MoltbookConnectionStatus {
  connected: boolean;
  status: 'unclaimed' | 'pending_claim' | 'claimed';
  agentName?: string;
  claimUrl?: string;
  karma?: number;
  followerCount?: number;
  followingCount?: number;
}

export interface MoltbookSearchResult {
  id: string;
  type: 'post' | 'comment';
  title?: string;
  content: string;
  upvotes: number;
  downvotes: number;
  similarity: number;
  author: { name: string };
  submolt?: { name: string; displayName: string };
  postId: string;
}

// ============================================================================
// Service Interface
// ============================================================================

export interface MoltbookServices {
  /**
   * Get Moltbook connection status
   */
  getConnectionStatus: () => Promise<MoltbookConnectionStatus>;

  /**
   * Register a new agent on Moltbook (returns claim URL for human verification)
   */
  register?: (name: string, description: string) => Promise<{
    apiKey: string;
    claimUrl: string;
    verificationCode: string;
  }>;

  /**
   * Get agent profile
   */
  getProfile?: () => Promise<MoltbookAgent>;

  /**
   * Update agent profile
   */
  updateProfile?: (description: string) => Promise<void>;

  /**
   * Create a post
   */
  createPost?: (submolt: string, title: string, content?: string, url?: string) => Promise<MoltbookPost>;

  /**
   * Get feed (personalized from subscriptions/follows, or global)
   */
  getFeed?: (options?: { 
    submolt?: string; 
    sort?: 'hot' | 'new' | 'top' | 'rising';
    limit?: number;
    personalized?: boolean;
  }) => Promise<MoltbookPost[]>;

  /**
   * Get a single post with comments
   */
  getPost?: (postId: string) => Promise<MoltbookPost & { comments: MoltbookComment[] }>;

  /**
   * Add a comment to a post
   */
  addComment?: (postId: string, content: string, parentId?: string) => Promise<MoltbookComment>;

  /**
   * Upvote a post
   */
  upvotePost?: (postId: string) => Promise<{ success: boolean; suggestion?: string }>;

  /**
   * Downvote a post
   */
  downvotePost?: (postId: string) => Promise<{ success: boolean }>;

  /**
   * Upvote a comment
   */
  upvoteComment?: (commentId: string) => Promise<{ success: boolean }>;

  /**
   * List submolts
   */
  listSubmolts?: () => Promise<MoltbookSubmolt[]>;

  /**
   * Subscribe to a submolt
   */
  subscribeSubmolt?: (submolt: string) => Promise<void>;

  /**
   * Unsubscribe from a submolt
   */
  unsubscribeSubmolt?: (submolt: string) => Promise<void>;

  /**
   * Follow another molty
   */
  follow?: (agentName: string) => Promise<void>;

  /**
   * Unfollow a molty
   */
  unfollow?: (agentName: string) => Promise<void>;

  /**
   * Search posts and comments semantically
   */
  search?: (query: string, options?: {
    type?: 'posts' | 'comments' | 'all';
    limit?: number;
  }) => Promise<MoltbookSearchResult[]>;

  /**
   * Get another molty's profile
   */
  getMoltyProfile?: (agentName: string) => Promise<MoltbookAgent>;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createMoltbookTools = (services: MoltbookServices) => [
  // -------------------------------------------------------------------------
  // Connection Status
  // -------------------------------------------------------------------------
  defineTool({
    name: 'moltbook_status',
    description: 'Check your Moltbook connection status. Shows if you\'re registered and claimed.',
    category: 'moltbook',
    toolset: 'moltbook',
    inputSchema: z.object({}),
    execute: async (_input: Record<string, never>, _context): Promise<ToolResult> => {
      const status = await services.getConnectionStatus();
      
      if (!status.connected) {
        return {
          success: true,
          data: {
            connected: false,
            status: 'not_registered',
            message: 'You are not registered on Moltbook. Use moltbook_register to create your account.',
            hint: 'Moltbook is a social network for AI agents. Register to post, comment, and connect with other moltys!',
          },
        };
      }

      if (status.status === 'pending_claim') {
        return {
          success: true,
          data: {
            connected: true,
            status: 'pending_claim',
            agentName: status.agentName,
            claimUrl: status.claimUrl,
            message: 'Your agent is registered but needs to be claimed by your human. Share the claim URL with them.',
          },
        };
      }

      return {
        success: true,
        data: {
          connected: true,
          status: 'claimed',
          agentName: status.agentName,
          karma: status.karma,
          followers: status.followerCount,
          following: status.followingCount,
          message: 'You are connected to Moltbook! You can post, comment, and interact with other moltys.',
        },
      };
    },
  }),

  // -------------------------------------------------------------------------
  // Registration (requires human claiming)
  // -------------------------------------------------------------------------
  defineTool({
    name: 'moltbook_register',
    description: 'Register on Moltbook. Returns a claim URL that your human must visit to verify ownership via Twitter/X.',
    category: 'moltbook',
    toolset: 'moltbook',
    inputSchema: z.object({
      name: z.string().min(3).max(30).describe('Your unique agent name on Moltbook (3-30 chars, alphanumeric)'),
      description: z.string().max(500).describe('Brief description of who you are and what you do'),
    }),
    execute: async (input: { name: string; description: string }, _context): Promise<ToolResult> => {
      if (!services.register) {
        return {
          success: false,
          error: 'Moltbook registration not available',
        };
      }

      try {
        const result = await services.register(input.name, input.description);
        return {
          success: true,
          data: {
            agentName: input.name,
            claimUrl: result.claimUrl,
            verificationCode: result.verificationCode,
            important: '⚠️ IMPORTANT: Ask your human to visit the claim URL to verify ownership via Twitter/X. Your API key has been stored securely.',
            nextSteps: [
              '1. Share the claim URL with your human',
              '2. They will post a verification tweet',
              '3. Once claimed, you can post and interact on Moltbook!',
            ],
          },
        };
      } catch (error) {
        return {
          success: false,
          error: String(error),
        };
      }
    },
  }),

  // -------------------------------------------------------------------------
  // Posts
  // -------------------------------------------------------------------------
  defineTool({
    name: 'moltbook_post',
    description: 'Create a post on Moltbook. Posts can be text or links. Rate limit: 1 post per 30 minutes.',
    category: 'moltbook',
    toolset: 'moltbook',
    inputSchema: z.object({
      submolt: z.string().default('general').describe('The submolt (community) to post in. Default: "general"'),
      title: z.string().min(3).max(300).describe('Post title (required, 3-300 chars)'),
      content: z.string().max(10000).optional().describe('Post body text (optional for link posts)'),
      url: z.string().url().optional().describe('URL for link posts (optional)'),
    }),
    execute: async (input: { submolt: string; title: string; content?: string; url?: string }, _context): Promise<ToolResult> => {
      if (!services.createPost) {
        return {
          success: false,
          error: 'Moltbook posting not available. Are you registered and claimed?',
        };
      }

      try {
        const post = await services.createPost(input.submolt, input.title, input.content, input.url);
        return {
          success: true,
          data: {
            post: {
              id: post.id,
              title: post.title,
              submolt: post.submolt.name,
              url: `https://www.moltbook.com/m/${post.submolt.name}/posts/${post.id}`,
            },
            message: `Posted to m/${input.submolt}! 🦞`,
            note: 'You can post again in 30 minutes.',
          },
        };
      } catch (error) {
        return {
          success: false,
          error: String(error),
        };
      }
    },
  }),

  defineTool({
    name: 'moltbook_feed',
    description: 'Get posts from Moltbook. Can get your personalized feed, a specific submolt, or the global feed.',
    category: 'moltbook',
    toolset: 'moltbook',
    inputSchema: z.object({
      submolt: z.string().optional().describe('Specific submolt to get posts from (e.g., "general", "aithoughts")'),
      sort: z.enum(['hot', 'new', 'top', 'rising']).default('hot').describe('Sort order'),
      limit: z.number().min(1).max(50).default(10).describe('Number of posts to fetch'),
      personalized: z.boolean().default(false).describe('Get personalized feed from subscriptions and follows'),
    }),
    execute: async (input: { submolt?: string; sort?: 'hot' | 'new' | 'top' | 'rising'; limit?: number; personalized?: boolean }, _context): Promise<ToolResult> => {
      if (!services.getFeed) {
        return {
          success: false,
          error: 'Moltbook feed not available',
        };
      }

      try {
        const posts = await services.getFeed({ submolt: input.submolt, sort: input.sort, limit: input.limit, personalized: input.personalized });
        return {
          success: true,
          data: {
            source: input.personalized ? 'personalized feed' : (input.submolt ? `m/${input.submolt}` : 'global'),
            sort: input.sort,
            count: posts.length,
            posts: posts.map(p => ({
              id: p.id,
              title: p.title,
              author: p.author.name,
              submolt: p.submolt.name,
              upvotes: p.upvotes,
              comments: p.commentCount,
              preview: p.content?.substring(0, 200),
            })),
          },
        };
      } catch (error) {
        return {
          success: false,
          error: String(error),
        };
      }
    },
  }),

  // -------------------------------------------------------------------------
  // Comments
  // -------------------------------------------------------------------------
  defineTool({
    name: 'moltbook_comment',
    description: 'Add a comment to a Moltbook post or reply to another comment.',
    category: 'moltbook',
    toolset: 'moltbook',
    inputSchema: z.object({
      postId: z.string().describe('The post ID to comment on'),
      content: z.string().min(1).max(10000).describe('Your comment text'),
      parentId: z.string().optional().describe('Parent comment ID if replying to a comment'),
    }),
    execute: async (input: { postId: string; content: string; parentId?: string }, _context): Promise<ToolResult> => {
      if (!services.addComment) {
        return {
          success: false,
          error: 'Moltbook commenting not available',
        };
      }

      try {
        const comment = await services.addComment(input.postId, input.content, input.parentId);
        return {
          success: true,
          data: {
            commentId: comment.id,
            message: input.parentId ? 'Reply posted! 🦞' : 'Comment added! 🦞',
          },
        };
      } catch (error) {
        return {
          success: false,
          error: String(error),
        };
      }
    },
  }),

  // -------------------------------------------------------------------------
  // Voting
  // -------------------------------------------------------------------------
  defineTool({
    name: 'moltbook_vote',
    description: 'Upvote or downvote a post or comment on Moltbook.',
    category: 'moltbook',
    toolset: 'moltbook',
    inputSchema: z.object({
      targetId: z.string().describe('The post ID or comment ID to vote on'),
      targetType: z.enum(['post', 'comment']).describe('Whether voting on a post or comment'),
      direction: z.enum(['up', 'down']).describe('Upvote or downvote'),
    }),
    execute: async (input: { targetId: string; targetType: 'post' | 'comment'; direction: 'up' | 'down' }, _context): Promise<ToolResult> => {
      try {
        if (input.targetType === 'post') {
          if (input.direction === 'up' && services.upvotePost) {
            const result = await services.upvotePost(input.targetId);
            return {
              success: true,
              data: {
                message: 'Upvoted! 🦞',
                suggestion: result.suggestion,
              },
            };
          } else if (input.direction === 'down' && services.downvotePost) {
            await services.downvotePost(input.targetId);
            return {
              success: true,
              data: { message: 'Downvoted.' },
            };
          }
        } else if (input.targetType === 'comment' && input.direction === 'up' && services.upvoteComment) {
          await services.upvoteComment(input.targetId);
          return {
            success: true,
            data: { message: 'Comment upvoted! 🦞' },
          };
        }

        return {
          success: false,
          error: 'Voting not available for this action',
        };
      } catch (error) {
        return {
          success: false,
          error: String(error),
        };
      }
    },
  }),

  // -------------------------------------------------------------------------
  // Submolts (Communities)
  // -------------------------------------------------------------------------
  defineTool({
    name: 'moltbook_submolts',
    description: 'List available submolts (communities) on Moltbook.',
    category: 'moltbook',
    toolset: 'moltbook',
    inputSchema: z.object({}),
    execute: async (_input: Record<string, never>, _context): Promise<ToolResult> => {
      if (!services.listSubmolts) {
        return {
          success: false,
          error: 'Submolt listing not available',
        };
      }

      try {
        const submolts = await services.listSubmolts();
        return {
          success: true,
          data: {
            count: submolts.length,
            submolts: submolts.map(s => ({
              name: s.name,
              displayName: s.displayName,
              description: s.description,
              subscribers: s.subscriberCount,
              posts: s.postCount,
            })),
          },
        };
      } catch (error) {
        return {
          success: false,
          error: String(error),
        };
      }
    },
  }),

  defineTool({
    name: 'moltbook_subscribe',
    description: 'Subscribe or unsubscribe from a submolt (community).',
    category: 'moltbook',
    toolset: 'moltbook',
    inputSchema: z.object({
      submolt: z.string().describe('Submolt name to subscribe to (e.g., "aithoughts")'),
      action: z.enum(['subscribe', 'unsubscribe']).describe('Subscribe or unsubscribe'),
    }),
    execute: async (input: { submolt: string; action: 'subscribe' | 'unsubscribe' }, _context): Promise<ToolResult> => {
      try {
        if (input.action === 'subscribe' && services.subscribeSubmolt) {
          await services.subscribeSubmolt(input.submolt);
          return {
            success: true,
            data: { message: `Subscribed to m/${input.submolt}! 🦞` },
          };
        } else if (input.action === 'unsubscribe' && services.unsubscribeSubmolt) {
          await services.unsubscribeSubmolt(input.submolt);
          return {
            success: true,
            data: { message: `Unsubscribed from m/${input.submolt}` },
          };
        }
        return {
          success: false,
          error: 'Subscription management not available',
        };
      } catch (error) {
        return {
          success: false,
          error: String(error),
        };
      }
    },
  }),

  // -------------------------------------------------------------------------
  // Following
  // -------------------------------------------------------------------------
  defineTool({
    name: 'moltbook_follow',
    description: 'Follow or unfollow another molty (agent). Be selective - only follow moltys whose content you consistently enjoy!',
    category: 'moltbook',
    toolset: 'moltbook',
    inputSchema: z.object({
      agentName: z.string().describe('The molty\'s name to follow/unfollow'),
      action: z.enum(['follow', 'unfollow']).describe('Follow or unfollow'),
    }),
    execute: async (input: { agentName: string; action: 'follow' | 'unfollow' }, _context): Promise<ToolResult> => {
      try {
        if (input.action === 'follow' && services.follow) {
          await services.follow(input.agentName);
          return {
            success: true,
            data: { message: `Now following ${input.agentName}! 🦞` },
          };
        } else if (input.action === 'unfollow' && services.unfollow) {
          await services.unfollow(input.agentName);
          return {
            success: true,
            data: { message: `Unfollowed ${input.agentName}` },
          };
        }
        return {
          success: false,
          error: 'Follow management not available',
        };
      } catch (error) {
        return {
          success: false,
          error: String(error),
        };
      }
    },
  }),

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------
  defineTool({
    name: 'moltbook_search',
    description: 'Semantic search across Moltbook posts and comments. Uses AI to find conceptually related content.',
    category: 'moltbook',
    toolset: 'moltbook',
    inputSchema: z.object({
      query: z.string().min(3).max(500).describe('Natural language search query (e.g., "how do agents handle memory?")'),
      type: z.enum(['posts', 'comments', 'all']).default('all').describe('What to search'),
      limit: z.number().min(1).max(50).default(20).describe('Max results'),
    }),
    execute: async (input: { query: string; type?: 'posts' | 'comments' | 'all'; limit?: number }, _context): Promise<ToolResult> => {
      if (!services.search) {
        return {
          success: false,
          error: 'Moltbook search not available',
        };
      }

      try {
        const results = await services.search(input.query, { type: input.type, limit: input.limit });
        return {
          success: true,
          data: {
            query: input.query,
            type: input.type,
            count: results.length,
            results: results.map(r => ({
              id: r.id,
              type: r.type,
              title: r.title,
              preview: r.content.substring(0, 200),
              author: r.author.name,
              submolt: r.submolt?.name,
              similarity: r.similarity,
              upvotes: r.upvotes,
              postId: r.postId,
            })),
          },
        };
      } catch (error) {
        return {
          success: false,
          error: String(error),
        };
      }
    },
  }),

  // -------------------------------------------------------------------------
  // Profile Viewing
  // -------------------------------------------------------------------------
  defineTool({
    name: 'moltbook_profile',
    description: 'View your profile or another molty\'s profile.',
    category: 'moltbook',
    toolset: 'moltbook',
    inputSchema: z.object({
      agentName: z.string().optional().describe('Agent name to view. Leave empty to view your own profile.'),
    }),
    execute: async (input: { agentName?: string }, _context): Promise<ToolResult> => {
      try {
        if (input.agentName && services.getMoltyProfile) {
          const profile = await services.getMoltyProfile(input.agentName);
          return {
            success: true,
            data: {
              agent: {
                name: profile.name,
                description: profile.description,
                karma: profile.karma,
                followers: profile.followerCount,
                following: profile.followingCount,
                claimed: profile.isClaimed,
                active: profile.isActive,
                joined: profile.createdAt,
              },
              profileUrl: `https://www.moltbook.com/u/${profile.name}`,
            },
          };
        } else if (services.getProfile) {
          const profile = await services.getProfile();
          return {
            success: true,
            data: {
              agent: {
                name: profile.name,
                description: profile.description,
                karma: profile.karma,
                followers: profile.followerCount,
                following: profile.followingCount,
              },
              profileUrl: `https://www.moltbook.com/u/${profile.name}`,
            },
          };
        }
        return {
          success: false,
          error: 'Profile viewing not available',
        };
      } catch (error) {
        return {
          success: false,
          error: String(error),
        };
      }
    },
  }),
];
