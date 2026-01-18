import type { UserSession } from '../types.js';
import type { SecretType } from '../types.js';

export interface TelegramSetupResult {
  success: boolean;
  error?: string;
  status?: {
    webhookUrl?: string;
    webhookInfo?: { url?: string; pending_update_count?: number };
    reRegistered?: boolean;
    botUsername?: string;
    botId?: number;
  };
}

export interface TelegramSetupDeps {
  validateTelegramToken: (token: string) => Promise<{ valid: boolean; error?: string; botInfo?: { username?: string; id?: number } }>;
  registerTelegramWebhook: (token: string, avatarId: string, secretToken: string) => Promise<{
    success: boolean;
    message: string;
    webhookUrl?: string;
    secretToken?: string;
    webhookInfo?: { url?: string; pending_update_count?: number };
    reRegistered?: boolean;
  }>;
  generateWebhookSecret: () => string;
  updateAvatar: (avatarId: string, update: unknown, session: UserSession) => Promise<void>;
  storeSecret: (avatarId: string, secretType: SecretType, name: string, value: string, session: UserSession, description: string) => Promise<void>;
}

export async function setupTelegramIntegration(params: {
  avatarId: string;
  token: string;
  session: UserSession;
  deps: TelegramSetupDeps;
}): Promise<TelegramSetupResult> {
  const { avatarId, token, session, deps } = params;

  const validation = await deps.validateTelegramToken(token);
  if (!validation.valid) {
    return { success: false, error: validation.error || 'Invalid Telegram bot token' };
  }

  const secretToken = deps.generateWebhookSecret();
  const webhookResult = await deps.registerTelegramWebhook(token, avatarId, secretToken);
  if (!webhookResult.success || !webhookResult.secretToken) {
    return { success: false, error: webhookResult.message || 'Failed to register Telegram webhook' };
  }

  await Promise.all([
    deps.updateAvatar(
      avatarId,
      {
        platforms: {
          telegram: {
            enabled: true,
            botUsername: validation.botInfo?.username,
            botId: validation.botInfo?.id,
          },
        },
      },
      session
    ),
    deps.storeSecret(
      avatarId,
      'telegram_bot_token',
      'default',
      token,
      session,
      `Telegram bot token for ${avatarId}`
    ),
    deps.storeSecret(
      avatarId,
      'telegram_webhook_secret',
      'default',
      webhookResult.secretToken,
      session,
      `Telegram webhook secret for ${avatarId}`
    ),
  ]);

  return {
    success: true,
    status: {
      webhookUrl: webhookResult.webhookUrl,
      webhookInfo: webhookResult.webhookInfo,
      reRegistered: webhookResult.reRegistered,
      botUsername: validation.botInfo?.username,
      botId: validation.botInfo?.id,
    },
  };
}
