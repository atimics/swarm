/**
 * Admin-only tools for configuration flows and UI prompts.
 */
import { z } from 'zod';
import { defineManualTool, defineTool, type ToolResult } from '../registry.js';
import type { TwitterServices } from './twitter.js';

export const TOGGLEABLE_FEATURES = ['media', 'voice', 'twitter', 'telegram', 'discord'] as const;
export type ToggleableFeature = typeof TOGGLEABLE_FEATURES[number];

/**
 * Supported integrations that can be configured via the configure_integration tool.
 * Each integration shows an inline configuration panel with:
 * - Enable/disable toggle
 * - Required credentials input
 * - Connection test
 * - Status display
 */
export const CONFIGURABLE_INTEGRATIONS = ['telegram', 'twitter', 'discord'] as const;
export type ConfigurableIntegration = typeof CONFIGURABLE_INTEGRATIONS[number];

export interface AdminToolServices {
  twitter?: Pick<TwitterServices, 'getConnectionStatus'>;
}

export function createAdminTools(services: AdminToolServices) {
  return [
    /**
     * Unified integration configuration tool.
     * Avatar calls this with the integration name, UI shows a complete setup panel.
     * Much simpler than having the avatar walk through multi-step credential flows.
     */
    defineManualTool({
      name: 'configure_integration',
      description: `Show the configuration panel for a platform integration (Telegram, Twitter, Discord).
The panel allows the user to:
- Enable or disable the integration
- Enter required credentials (bot tokens, API keys)
- Test the connection
- View current status

Use this when:
- Setting up a new integration
- Resetting credentials (e.g., "reset my Telegram token")
- Checking integration status
- Troubleshooting connection issues

The UI handles all the complexity - just call this tool with the integration name.`,
      toolset: 'admin',
      platforms: ['admin-ui'],
      inputSchema: z.object({
        integration: z.enum(CONFIGURABLE_INTEGRATIONS).describe('Which integration to configure'),
        reason: z.string().optional().describe('Brief context for why configuration is needed'),
      }),
    }),

    defineManualTool({
      name: 'request_feature_toggle',
      description: 'Show the user a toggle switch to enable or disable a feature (media, voice, Twitter, Telegram, Discord).',
      toolset: 'admin',
      platforms: ['admin-ui'],
      inputSchema: z.object({
        feature: z.enum(TOGGLEABLE_FEATURES).describe('The feature to toggle'),
        currentState: z.boolean().optional().describe('Current enabled state (computed server-side)'),
        label: z.string().describe('Human-readable label for the feature (e.g., "Media Generation")'),
        description: z.string().optional().describe('Optional description of what this feature does'),
      }),
    }),

    defineManualTool({
      name: 'request_twitter_connection',
      description: 'Prompt the admin to connect an X/Twitter account via OAuth.',
      toolset: 'admin',
      platforms: ['admin-ui'],
      inputSchema: z.object({
        message: z.string().optional().describe('Optional message explaining why connection is needed'),
      }),
    }),

    defineTool({
      name: 'get_twitter_connection_status',
      description: 'Check if an X/Twitter account is connected to this avatar.',
      category: 'readonly',
      toolset: 'twitter',
      platforms: ['admin-ui', 'api'],
      inputSchema: z.object({}),
      execute: async (): Promise<ToolResult> => {
        if (!services.twitter) {
          return { success: false, error: 'Twitter service is not configured.' };
        }

        const status = await services.twitter.getConnectionStatus();
        if (status.connected) {
          return {
            success: true,
            data: {
              connected: true,
              username: status.username,
              message: `Connected to @${status.username}`,
            },
          };
        }

        return {
          success: true,
          data: {
            connected: false,
            message: 'No X/Twitter account connected. Use request_twitter_connection to prompt the user to connect.',
          },
        };
      },
    }),
  ];
}

export default createAdminTools;
