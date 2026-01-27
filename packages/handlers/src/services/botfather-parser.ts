/**
 * BotFather Parser Service
 * Parses and validates bot tokens from BotFather messages
 */
import { logger } from '@swarm/core';
import { BOT_TOKEN_REGEX, BOT_LINK_REGEX } from '../types/telegram-admin.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Parsed bot token information
 */
export interface ParsedBotToken {
  /** The raw bot token */
  token: string;
  /** The bot ID (numeric part before the colon) */
  botId: number;
  /** The bot username (if found in the message) */
  botUsername?: string;
}

/**
 * Validated bot information from Telegram API
 */
export interface ValidatedBotInfo {
  /** Bot ID */
  id: number;
  /** Bot username (without @) */
  username: string;
  /** Bot first name (display name) */
  firstName: string;
  /** Whether the bot can join groups */
  canJoinGroups: boolean;
  /** Whether the bot can read all group messages */
  canReadAllGroupMessages: boolean;
  /** Whether inline mode is enabled */
  supportsInlineQueries: boolean;
}

/**
 * Result of bot token parsing
 */
export type ParseResult =
  | { success: true; data: ParsedBotToken }
  | { success: false; error: 'no_token' | 'invalid_format' };

/**
 * Result of bot token validation
 */
export type ValidationResult =
  | { success: true; data: ValidatedBotInfo }
  | { success: false; error: 'invalid_token' | 'network_error' | 'api_error'; message?: string };

// =============================================================================
// PARSER FUNCTIONS
// =============================================================================

/**
 * Parse a bot token from message text
 * Extracts the token and optionally the bot username from t.me links
 */
export function parseBotToken(text: string): ParseResult {
  // Try to find a bot token in the text
  const tokenMatch = text.match(BOT_TOKEN_REGEX);

  if (!tokenMatch) {
    return { success: false, error: 'no_token' };
  }

  const token = tokenMatch[1];

  // Validate token format more strictly
  const parts = token.split(':');
  if (parts.length !== 2) {
    return { success: false, error: 'invalid_format' };
  }

  const botIdStr = parts[0];
  const botId = parseInt(botIdStr, 10);

  if (isNaN(botId) || botId <= 0) {
    return { success: false, error: 'invalid_format' };
  }

  // Try to extract bot username from t.me link
  const linkMatch = text.match(BOT_LINK_REGEX);
  const botUsername = linkMatch ? linkMatch[1] : undefined;

  return {
    success: true,
    data: {
      token,
      botId,
      botUsername,
    },
  };
}

/**
 * Validate a bot token by calling Telegram's getMe API
 */
export async function validateBotToken(token: string): Promise<ValidationResult> {
  const url = `https://api.telegram.org/bot${token}/getMe`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        return { success: false, error: 'invalid_token' };
      }
      return {
        success: false,
        error: 'api_error',
        message: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const data = await response.json() as {
      ok: boolean;
      result?: {
        id: number;
        is_bot: boolean;
        first_name: string;
        username: string;
        can_join_groups?: boolean;
        can_read_all_group_messages?: boolean;
        supports_inline_queries?: boolean;
      };
      description?: string;
    };

    if (!data.ok || !data.result) {
      return {
        success: false,
        error: 'api_error',
        message: data.description || 'Unknown API error',
      };
    }

    const result = data.result;

    if (!result.is_bot) {
      return {
        success: false,
        error: 'invalid_token',
        message: 'Token does not belong to a bot',
      };
    }

    logger.info('Validated bot token', {
      botId: result.id,
      botUsername: result.username,
    });

    return {
      success: true,
      data: {
        id: result.id,
        username: result.username,
        firstName: result.first_name,
        canJoinGroups: result.can_join_groups ?? true,
        canReadAllGroupMessages: result.can_read_all_group_messages ?? false,
        supportsInlineQueries: result.supports_inline_queries ?? false,
      },
    };
  } catch (error) {
    logger.error('Failed to validate bot token', error);
    return {
      success: false,
      error: 'network_error',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Parse and validate a bot token in one step
 * First parses the token from text, then validates it with Telegram API
 */
export async function parseAndValidateBotToken(
  text: string
): Promise<
  | { success: true; token: string; botInfo: ValidatedBotInfo }
  | { success: false; error: string }
> {
  // Parse the token from the text
  const parseResult = parseBotToken(text);

  if (!parseResult.success) {
    switch (parseResult.error) {
      case 'no_token':
        return { success: false, error: 'No bot token found in the message' };
      case 'invalid_format':
        return { success: false, error: 'Invalid bot token format' };
    }
  }

  const { token } = parseResult.data;

  // Validate the token with Telegram API
  const validationResult = await validateBotToken(token);

  if (!validationResult.success) {
    switch (validationResult.error) {
      case 'invalid_token':
        return { success: false, error: 'Invalid or expired bot token' };
      case 'network_error':
        return { success: false, error: 'Failed to connect to Telegram. Please try again.' };
      case 'api_error':
        return { success: false, error: validationResult.message || 'Telegram API error' };
    }
  }

  return {
    success: true,
    token,
    botInfo: validationResult.data,
  };
}

/**
 * Mask a bot token for logging (shows only first 4 and last 4 chars)
 */
export function maskToken(token: string): string {
  if (token.length <= 12) {
    return '****';
  }
  return `${token.slice(0, 4)}****${token.slice(-4)}`;
}

/**
 * Check if text looks like it might contain a bot token (quick check without validation)
 */
export function mightContainBotToken(text: string): boolean {
  return BOT_TOKEN_REGEX.test(text);
}
