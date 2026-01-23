#!/usr/bin/env node

/**
 * Re-register the currently configured Telegram webhook URL with a given secret_token.
 *
 * Use-case: bot looks "silent" because Telegram delivers updates, but our webhook handler
 * ignores them due to a secret_token mismatch.
 *
 * Inputs (env):
 * - AVATAR_ID: avatar id (for display only)
 * - BOT_TOKEN: Telegram bot token
 * - WEBHOOK_SECRET: secret_token to set
 */

const avatarId = process.env.AVATAR_ID ?? '';
const botToken = process.env.BOT_TOKEN;
const webhookSecret = process.env.WEBHOOK_SECRET;

if (!botToken) {
  console.error('Missing BOT_TOKEN env var');
  process.exit(1);
}
if (!webhookSecret) {
  console.error('Missing WEBHOOK_SECRET env var');
  process.exit(1);
}

async function telegram(method, body) {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!json?.ok) {
    throw new Error(`${method} failed: ${json?.description ?? 'unknown_error'}`);
  }
  return json;
}

const pickWebhookInfo = (result) => ({
  url: result?.url ?? null,
  pending_update_count: result?.pending_update_count ?? null,
  last_error_date: result?.last_error_date ?? null,
  last_error_message: result?.last_error_message ?? null,
});

(async () => {
  const before = await telegram('getWebhookInfo');
  const currentUrl = before?.result?.url;
  if (!currentUrl) {
    console.log(`avatarId=${avatarId}`);
    console.log('error=no_webhook_url_set');
    process.exit(2);
  }

  const setRes = await telegram('setWebhook', {
    url: currentUrl,
    secret_token: webhookSecret,
    allowed_updates: ['message', 'edited_message', 'callback_query'],
    drop_pending_updates: true,
    max_connections: 40,
  });

  const after = await telegram('getWebhookInfo');

  console.log(`avatarId=${avatarId}`);
  console.log(`url_before=${currentUrl}`);
  console.log(`setWebhook_ok=${String(setRes?.ok)}`);
  console.log(`setWebhook_description=${setRes?.description ?? ''}`);
  console.log(`webhookInfo_after=${JSON.stringify(pickWebhookInfo(after?.result))}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
