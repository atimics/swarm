/**
 * Voice Tools
 *
 * Tools for voice generation and sending voice messages.
 * Audio transcription is handled automatically by the platform.
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

export interface VoiceTranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface VoiceTranscription {
  text: string;
  language?: string;
  confidence?: number;
  segments?: VoiceTranscriptSegment[];
}

export interface VoiceMessage {
  assetId: string;
  url: string;
  durationMs?: number;
  format?: 'ogg' | 'mp3' | 'wav';
}

export interface VoiceServices {
  /**
   * Transcribe audio (used internally for auto-transcription, not exposed as tool)
   */
  transcribeAudio: (params: {
    assetId?: string;
    url?: string;
    platformFileId?: string;
    language?: string;
    model?: string;
    diarize?: boolean;
  }) => Promise<VoiceTranscription>;
  /**
   * Create a voice for the agent based on a description.
   * This is the consolidated voice creation method that:
   * 1. Generates a voice seed audio based on the description
   * 2. Clones the voice from the seed
   * 3. Sets it as the agent's active voice profile
   * 4. Generates a voice introduction message
   */
  createMyVoice: (params: {
    agentId: string;
    description: string;
  }) => Promise<{ voiceId: string; message: string; previewUrl?: string; introAssetId?: string; introUrl?: string }>;
  /**
   * Check if the agent has a voice configured
   */
  hasVoice: (agentId: string) => Promise<{ hasVoice: boolean; voiceId?: string; voiceStyle?: string }>;
  /**
   * Generate and optionally send a voice message.
   * On Telegram: sends directly to the conversation
   * On Web/other: returns the audio URL for playback
   */
  sendVoiceMessage: (params: {
    agentId: string;
    platform: string;
    text: string;
    conversationId?: string;
    voiceId?: string;
    format?: 'ogg' | 'mp3' | 'wav';
    speed?: number;
    replyToMessageId?: string;
  }) => Promise<{ success: boolean; assetId?: string; url?: string; sent?: boolean }>;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createVoiceTools = (services: VoiceServices) => [
  defineTool({
    name: 'create_my_voice',
    description: 'Create your voice for speaking. This is the only tool you need to set up voice messages - it handles everything automatically: generates a voice seed based on your description, clones it into a voice profile, sets it as your active voice, and generates a voice introduction message you can send. Use this when you want to send voice messages but haven\'t configured your voice yet.',
    category: 'config',
    toolset: 'voice',
    inputSchema: z.object({
      description: z.string().min(1)
        .describe('Description of your desired voice - include personality traits, tone, gender, age, accent, speaking style. Example: "A warm female voice with a slight Southern accent, playful and energetic, speaks quickly with enthusiasm"'),
    }),
    contextBuilder: async (context) => {
      try {
        const status = await services.hasVoice(context.agentId);
        if (status.hasVoice) {
          // Don't show this tool if voice is already configured
          return `⚠️ SKIP THIS TOOL - You already have a voice configured (ID: ${status.voiceId}). Use send_voice_message instead to speak.`;
        }
        return '🎤 You do not have a voice yet. Use this tool to create one based on your personality, then use send_voice_message to speak.';
      } catch {
        return undefined;
      }
    },
    execute: async (input, context): Promise<ToolResult> => {
      // Check if voice already exists
      try {
        const status = await services.hasVoice(context.agentId);
        if (status.hasVoice) {
          return {
            success: true,
            data: {
              message: 'You already have a voice configured! Use send_voice_message to speak.',
              voiceId: status.voiceId,
              voiceStyle: status.voiceStyle,
            }
          };
        }
      } catch {
        // Continue with creation
      }

      try {
        const result = await services.createMyVoice({
          agentId: context.agentId,
          description: input.description,
        });
        return { success: true, data: result };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        if (msg.includes('Replicate API key not configured')) {
          return { success: false, error: `Voice creation requires replicate_api_key to be configured. Ask an admin to set it up globally or for your agent.` };
        }
        if (msg.includes('Not enough energy')) {
          return { success: false, error: msg };
        }
        return { success: false, error: `Failed to create voice: ${msg}` };
      }
    },
  }),

  defineTool({
    name: 'send_voice_message',
    description: 'Speak! Generate a voice message from text and send it. On Telegram, sends directly to the chat. On web, returns the audio URL for playback. Requires a voice profile (use create_my_voice first) or will use OpenAI TTS as fallback.',
    category: 'media',
    toolset: 'voice',
    inputSchema: z.object({
      text: z.string().min(1).describe('What you want to say - the text to convert to speech'),
      conversationId: z.string().optional().describe('Conversation/chat ID to send to (required for Telegram, optional for web)'),
      voiceId: z.string().optional().describe('Voice profile ID to use (uses your configured voice if not specified)'),
      format: z.enum(['ogg', 'mp3', 'wav']).optional().describe('Audio format (default: ogg)'),
      speed: z.number().min(0.5).max(2).optional().describe('Playback speed (0.5-2.0)'),
      replyToMessageId: z.string().optional().describe('Message ID to reply to'),
    }),
    contextBuilder: async (context) => {
      try {
        const status = await services.hasVoice(context.agentId);
        if (status.hasVoice) {
          return `🎤 Your voice is ready (${status.voiceStyle || 'voice-clone'}). Speak your message!`;
        }
        return '🎤 No custom voice configured - will use OpenAI TTS with default voice. Use create_my_voice to set up a personalized voice.';
      } catch {
        return undefined;
      }
    },
    execute: async (input, context): Promise<ToolResult> => {
      // Validate conversationId for Telegram
      if (context.platform === 'telegram' && !input.conversationId && !context.conversationId) {
        return { success: false, error: 'conversationId is required for sending voice messages on Telegram' };
      }

      try {
        const result = await services.sendVoiceMessage({
          agentId: context.agentId,
          platform: context.platform,
          text: input.text,
          conversationId: input.conversationId || context.conversationId,
          voiceId: input.voiceId,
          format: input.format,
          speed: input.speed,
          replyToMessageId: input.replyToMessageId,
        });

        // Return appropriate response based on platform
        if (result.sent) {
          return { success: true, data: { message: 'Voice message sent!', ...result } };
        } else {
          return {
            success: true,
            data: {
              message: 'Voice message generated! Play the audio URL.',
              assetId: result.assetId,
              url: result.url,
            }
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        if (msg.includes('API key not configured')) {
          const keyType = msg.includes('Replicate') ? 'replicate_api_key' : 'openai_api_key';
          return { success: false, error: `Voice generation requires ${keyType} to be configured. Ask an admin to set it up.` };
        }
        if (msg.includes('Not enough energy')) {
          return { success: false, error: msg };
        }
        if (msg.includes('bot token not configured')) {
          return { success: false, error: 'Telegram bot token not configured. Voice messages require Telegram integration.' };
        }
        return { success: false, error: `Failed to send voice message: ${msg}` };
      }
    },
  }),
];

export default createVoiceTools;
