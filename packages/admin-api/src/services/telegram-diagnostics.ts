import { getAvatar } from './avatars.js';
import { _getSecretValueInternal } from './secrets.js';
import type { SecretType } from '../types.js';
import {
  getTelegramWebhookInfoDetailed,
  getTelegramWebhookUrlForAvatar,
  validateTelegramToken,
  type TelegramWebhookInfoDetailed,
} from './telegram.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

export type TelegramDiagnosticsIssueCode =
  | 'missing_bot_token'
  | 'invalid_bot_token'
  | 'missing_webhook_secret'
  | 'webhook_url_mismatch'
  | 'webhook_pending_updates'
  | 'webhook_last_error'
  | 'telegram_disabled_in_config'
  | 'unknown_error';

export interface TelegramLastUpdateSnapshot {
  receivedAt: number;
  updateId?: number;
  chatId?: number;
  chatType?: string;
  fromUserId?: number;
  messageId?: number;
  textPreview?: string;
}

export interface TelegramDiagnosis {
  avatarId: string;
  platformEnabled: boolean;
  tokenPresent: boolean;
  webhookSecretPresent: boolean;
  bot?: {
    id?: number;
    username?: string;
    first_name?: string;
    is_bot?: boolean;
  };
  webhook: {
    expectedUrl: string;
    actualUrl?: string;
    isCorrectUrl?: boolean;
    pendingUpdateCount?: number;
    lastErrorDate?: number;
    lastErrorMessage?: string;
    ipAddress?: string;
    maxConnections?: number;
    allowedUpdates?: string[];
  };
  lastUpdate?: {
    snapshot?: TelegramLastUpdateSnapshot;
    secondsAgo?: number;
  };
  issues: Array<{ code: TelegramDiagnosticsIssueCode; message: string }>;
}

export interface TelegramDiagnosticsDeps {
  now?: () => number;
  getAvatar?: typeof getAvatar;
  getSecretValueForAvatar?: (avatarId: string, secretType: SecretType) => Promise<string | null>;
  validateTelegramToken?: typeof validateTelegramToken;
  getTelegramWebhookInfoDetailed?: typeof getTelegramWebhookInfoDetailed;
  getTelegramWebhookUrlForAvatar?: typeof getTelegramWebhookUrlForAvatar;
  getLastTelegramUpdateSnapshot?: (avatarId: string) => Promise<TelegramLastUpdateSnapshot | undefined>;
}

const DEFAULT_LAST_UPDATE_SK = 'TELEGRAM#LAST_UPDATE';

async function defaultGetLastTelegramUpdateSnapshot(
  avatarId: string
): Promise<TelegramLastUpdateSnapshot | undefined> {
  const tableName = process.env.ADMIN_TABLE;
  if (!tableName) return undefined;

  const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });

  const res = await dynamoClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: `AVATAR#${avatarId}`, sk: DEFAULT_LAST_UPDATE_SK },
      ConsistentRead: true,
    })
  );

  const item = res.Item as undefined | { snapshot?: TelegramLastUpdateSnapshot };
  return item?.snapshot;
}

function addIssue(
  issues: TelegramDiagnosis['issues'],
  code: TelegramDiagnosticsIssueCode,
  message: string
) {
  issues.push({ code, message });
}

function deriveWebhookIssues(
  issues: TelegramDiagnosis['issues'],
  expectedUrl: string,
  webhookInfo: TelegramWebhookInfoDetailed
) {
  if (webhookInfo.url && webhookInfo.url !== expectedUrl) {
    addIssue(
      issues,
      'webhook_url_mismatch',
      `Telegram webhook URL is set to ${webhookInfo.url}, expected ${expectedUrl}`
    );
  }

  if ((webhookInfo.pending_update_count || 0) > 0) {
    addIssue(
      issues,
      'webhook_pending_updates',
      `Telegram has ${webhookInfo.pending_update_count} pending update(s)`
    );
  }

  if (webhookInfo.last_error_message) {
    addIssue(
      issues,
      'webhook_last_error',
      `Telegram webhook last error: ${webhookInfo.last_error_message}`
    );
  }
}

export async function diagnoseTelegram(
  avatarId: string,
  deps: TelegramDiagnosticsDeps = {}
): Promise<TelegramDiagnosis> {
  const now = deps.now ?? (() => Date.now());
  const getAvatarImpl = deps.getAvatar ?? getAvatar;
  const getSecretValueForAvatarImpl =
    deps.getSecretValueForAvatar
    ?? (async (id: string, secretType: SecretType) => {
      return _getSecretValueInternal(id, secretType, 'default');
    });
  const validateTelegramTokenImpl = deps.validateTelegramToken ?? validateTelegramToken;
  const getTelegramWebhookInfoDetailedImpl =
    deps.getTelegramWebhookInfoDetailed ?? getTelegramWebhookInfoDetailed;
  const getTelegramWebhookUrlForAvatarImpl =
    deps.getTelegramWebhookUrlForAvatar ?? getTelegramWebhookUrlForAvatar;
  const getLastTelegramUpdateSnapshotImpl =
    deps.getLastTelegramUpdateSnapshot ?? defaultGetLastTelegramUpdateSnapshot;

  const expectedUrl = getTelegramWebhookUrlForAvatarImpl(avatarId);
  const issues: TelegramDiagnosis['issues'] = [];

  const avatar = await getAvatarImpl(avatarId);
  const platformEnabled = Boolean(avatar?.platforms?.telegram?.enabled);

  const botToken = await getSecretValueForAvatarImpl(avatarId, 'telegram_bot_token');
  const webhookSecret = await getSecretValueForAvatarImpl(avatarId, 'telegram_webhook_secret');

  const diagnosis: TelegramDiagnosis = {
    avatarId,
    platformEnabled,
    tokenPresent: Boolean(botToken),
    webhookSecretPresent: Boolean(webhookSecret),
    webhook: {
      expectedUrl,
    },
    issues,
  };

  if (!platformEnabled) {
    addIssue(issues, 'telegram_disabled_in_config', 'Telegram is disabled in avatar config');
  }

  if (!botToken) {
    addIssue(issues, 'missing_bot_token', 'Missing Telegram bot token secret');
    return diagnosis;
  }

  if (!webhookSecret) {
    addIssue(issues, 'missing_webhook_secret', 'Missing Telegram webhook secret');
  }

  const validation = await validateTelegramTokenImpl(botToken);
  if (!validation.valid) {
    addIssue(issues, 'invalid_bot_token', 'Telegram bot token failed validation (getMe)');
    return diagnosis;
  }
  diagnosis.bot = {
    id: validation.botInfo?.id,
    username: validation.botInfo?.username,
    first_name: validation.botInfo?.firstName,
    is_bot: true,
  };

  try {
    const webhookInfo = await getTelegramWebhookInfoDetailedImpl(botToken);
    diagnosis.webhook.actualUrl = webhookInfo.url;
    diagnosis.webhook.isCorrectUrl = !webhookInfo.url || webhookInfo.url === expectedUrl;
    diagnosis.webhook.pendingUpdateCount = webhookInfo.pending_update_count;
    diagnosis.webhook.lastErrorDate = webhookInfo.last_error_date;
    diagnosis.webhook.lastErrorMessage = webhookInfo.last_error_message;
    diagnosis.webhook.ipAddress = webhookInfo.ip_address;
    diagnosis.webhook.maxConnections = webhookInfo.max_connections;
    diagnosis.webhook.allowedUpdates = webhookInfo.allowed_updates;

    deriveWebhookIssues(issues, expectedUrl, webhookInfo);
  } catch {
    addIssue(issues, 'unknown_error', 'Failed to fetch Telegram webhook info');
  }

  try {
    const snapshot = await getLastTelegramUpdateSnapshotImpl(avatarId);
    if (snapshot) {
      const secondsAgo = Math.max(0, Math.floor((now() - snapshot.receivedAt) / 1000));
      diagnosis.lastUpdate = { snapshot, secondsAgo };
    }
  } catch {
    // best-effort
  }

  return diagnosis;
}
