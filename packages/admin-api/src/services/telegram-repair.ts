import type { TelegramDiagnosis } from './telegram-diagnostics.js';

export interface TelegramRepairOptions {
  /**
   * If true, repair even when the webhook is already correct.
   * This should generally be false for safety.
   */
  force?: boolean;

  /**
   * If true, attempt repair even if Telegram is disabled in avatar config.
   * Default false to avoid surprising side-effects.
   */
  includeDisabled?: boolean;

  /**
   * If true, attempt repair when Telegram reports pending updates.
   * Pending updates can accumulate when delivery is failing.
   */
  repairOnPendingUpdates?: boolean;

  /**
   * If true, attempt repair when Telegram reports a last webhook error.
   */
  repairOnLastError?: boolean;
}

export type TelegramRepairPlan =
  | { action: 'skip'; reason: string }
  | { action: 'repair'; reason: string };

export function computeTelegramRepairPlan(
  diagnosis: TelegramDiagnosis,
  options: TelegramRepairOptions = {}
): TelegramRepairPlan {
  const includeDisabled = Boolean(options.includeDisabled);
  const force = Boolean(options.force);
  const repairOnPendingUpdates = Boolean(options.repairOnPendingUpdates);
  const repairOnLastError = Boolean(options.repairOnLastError);

  if (!diagnosis.platformEnabled && !includeDisabled) {
    return { action: 'skip', reason: 'Telegram disabled in avatar config' };
  }

  if (!diagnosis.tokenPresent) {
    return { action: 'skip', reason: 'Missing Telegram bot token' };
  }

  if (force) {
    return { action: 'repair', reason: 'Forced repair requested' };
  }

  const issueCodes = new Set(diagnosis.issues.map(i => i.code));

  if (issueCodes.has('webhook_url_mismatch')) {
    return { action: 'repair', reason: 'Telegram webhook URL mismatch' };
  }

  if (repairOnPendingUpdates && issueCodes.has('webhook_pending_updates')) {
    return { action: 'repair', reason: 'Telegram webhook has pending updates' };
  }

  if (repairOnLastError && issueCodes.has('webhook_last_error')) {
    return { action: 'repair', reason: 'Telegram webhook last error reported' };
  }

  return { action: 'skip', reason: 'Webhook already matches expected URL' };
}
