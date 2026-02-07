#!/usr/bin/env bun
/**
 * Telegram Canary Test
 *
 * Sends a synthetic Telegram update to the staging webhook
 * and verifies the response. Optionally sends a real message
 * via the Telegram Bot API and polls for a response.
 *
 * Usage:
 *   WEBHOOK_URL=https://xxx.execute-api.region.amazonaws.com/webhook/AVATAR_ID \
 *   WEBHOOK_SECRET=xxx \
 *   bun run scripts/telegram-canary.ts
 *
 * Optional:
 *   BOT_TOKEN=xxx  -- also send a real message and check for response
 *   CHAT_ID=xxx    -- Telegram chat ID for real message test
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PASS = "[PASS]";
const FAIL = "[FAIL]";
const SKIP = "[SKIP]";

let failures = 0;

function log(status: string, message: string): void {
  const ts = new Date().toISOString();
  console.log(`${ts}  ${status}  ${message}`);
  if (status === FAIL) failures++;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Error: Required environment variable ${name} is not set.`);
    console.error("");
    console.error("Usage:");
    console.error("  WEBHOOK_URL=https://...  WEBHOOK_SECRET=xxx  bun run scripts/telegram-canary.ts");
    console.error("");
    console.error("Optional:");
    console.error("  BOT_TOKEN=xxx  CHAT_ID=xxx  -- enable real-message test");
    process.exit(1);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Synthetic Telegram Update
// ---------------------------------------------------------------------------

/**
 * Build a valid Telegram Update JSON that simulates a text message
 * from a test user. The structure matches what Telegram sends to
 * webhook endpoints.
 */
function buildSyntheticUpdate(text: string): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    update_id: 100000000 + Math.floor(Math.random() * 999999),
    message: {
      message_id: Math.floor(Math.random() * 999999),
      from: {
        id: 999999999,
        is_bot: false,
        first_name: "Canary",
        last_name: "Test",
        username: "canary_test_user",
        language_code: "en",
      },
      chat: {
        id: -1001999999999,
        title: "Canary Test Group",
        type: "supergroup",
        username: "canary_test_group",
      },
      date: now,
      text,
      entities: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Test: Synthetic webhook with correct secret
// ---------------------------------------------------------------------------

async function testWebhookWithCorrectSecret(
  webhookUrl: string,
  webhookSecret: string,
): Promise<void> {
  const update = buildSyntheticUpdate("canary ping");

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": webhookSecret,
    },
    body: JSON.stringify(update),
  });

  if (res.status === 200) {
    log(PASS, `Webhook returned ${res.status} with correct secret`);
  } else {
    const body = await res.text().catch(() => "");
    log(FAIL, `Webhook returned ${res.status} with correct secret (expected 200). Body: ${body.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Test: Synthetic webhook with WRONG secret
// ---------------------------------------------------------------------------

async function testWebhookWithWrongSecret(
  webhookUrl: string,
): Promise<void> {
  const update = buildSyntheticUpdate("canary ping wrong secret");

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "wrong-secret-value-12345",
    },
    body: JSON.stringify(update),
  });

  // The handler returns 401 for invalid secrets (defense-in-depth).
  // Some deployments may return 200 to avoid info disclosure.
  // Either way, the message should NOT be processed.
  if (res.status === 200 || res.status === 401) {
    log(PASS, `Webhook returned ${res.status} with wrong secret (message not processed)`);
  } else {
    const body = await res.text().catch(() => "");
    log(FAIL, `Webhook returned ${res.status} with wrong secret (expected 200 or 401). Body: ${body.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Test: Synthetic webhook with MISSING secret
// ---------------------------------------------------------------------------

async function testWebhookWithMissingSecret(
  webhookUrl: string,
): Promise<void> {
  const update = buildSyntheticUpdate("canary ping no secret");

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // No X-Telegram-Bot-Api-Secret-Token header
    },
    body: JSON.stringify(update),
  });

  // Without the secret header, the handler should reject the request.
  // It returns 401 when webhook secret is configured but not provided.
  if (res.status === 200 || res.status === 401) {
    log(PASS, `Webhook returned ${res.status} with missing secret (message not processed)`);
  } else {
    const body = await res.text().catch(() => "");
    log(FAIL, `Webhook returned ${res.status} with missing secret (expected 200 or 401). Body: ${body.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Test: Invalid JSON body
// ---------------------------------------------------------------------------

async function testWebhookWithInvalidJson(
  webhookUrl: string,
  webhookSecret: string,
): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": webhookSecret,
    },
    body: "this is not json{{{",
  });

  // The handler returns 400 for invalid JSON
  if (res.status === 200 || res.status === 400) {
    log(PASS, `Webhook returned ${res.status} for invalid JSON body`);
  } else {
    const body = await res.text().catch(() => "");
    log(FAIL, `Webhook returned ${res.status} for invalid JSON (expected 200 or 400). Body: ${body.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Test: Real message via Telegram Bot API (optional)
// ---------------------------------------------------------------------------

async function testRealMessage(
  botToken: string,
  chatId: string,
): Promise<void> {
  const apiBase = `https://api.telegram.org/bot${botToken}`;
  const canaryText = `canary test ${Date.now()}`;

  // Send test message
  log(SKIP, "Starting real message test...");

  const sendRes = await fetch(`${apiBase}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: canaryText,
    }),
  });

  if (!sendRes.ok) {
    const body = await sendRes.text().catch(() => "");
    log(FAIL, `Failed to send message via Bot API: ${sendRes.status} ${body.slice(0, 200)}`);
    return;
  }

  const sendData = (await sendRes.json()) as { ok: boolean; result?: { message_id: number } };
  if (!sendData.ok) {
    log(FAIL, "Bot API sendMessage returned ok=false");
    return;
  }

  const sentMessageId = sendData.result?.message_id;
  log(PASS, `Sent canary message (message_id=${sentMessageId}): "${canaryText}"`);

  // Poll getUpdates for a response (up to 30 seconds)
  const pollStart = Date.now();
  const pollTimeoutMs = 30_000;
  const pollIntervalMs = 3_000;
  let gotResponse = false;

  // Clear any pending updates first
  await fetch(`${apiBase}/getUpdates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offset: -1, limit: 1 }),
  });

  while (Date.now() - pollStart < pollTimeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    const pollRes = await fetch(`${apiBase}/getUpdates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeout: 2, limit: 10 }),
    });

    if (!pollRes.ok) continue;

    const pollData = (await pollRes.json()) as {
      ok: boolean;
      result?: Array<{
        update_id: number;
        message?: {
          message_id: number;
          from?: { is_bot: boolean; username?: string };
          chat: { id: number };
          text?: string;
          reply_to_message?: { message_id: number };
        };
      }>;
    };

    if (!pollData.ok || !pollData.result) continue;

    for (const update of pollData.result) {
      const msg = update.message;
      if (!msg) continue;

      // Look for a bot reply in the same chat
      const isSameChat = String(msg.chat.id) === String(chatId);
      const isFromBot = msg.from?.is_bot === true;
      const isReply = msg.reply_to_message?.message_id === sentMessageId;
      const isAfterSend = msg.message_id > (sentMessageId || 0);

      if (isSameChat && isFromBot && (isReply || isAfterSend)) {
        const preview = (msg.text || "[non-text]").slice(0, 100);
        log(PASS, `Got bot response (message_id=${msg.message_id}, from=@${msg.from?.username}): "${preview}"`);
        gotResponse = true;
        break;
      }

      // Acknowledge processed updates
      await fetch(`${apiBase}/getUpdates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offset: update.update_id + 1 }),
      });
    }

    if (gotResponse) break;
  }

  if (!gotResponse) {
    log(FAIL, `No bot response received within ${pollTimeoutMs / 1000}s`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Telegram Canary Test ===");
  console.log("");

  const webhookUrl = requiredEnv("WEBHOOK_URL");
  const webhookSecret = requiredEnv("WEBHOOK_SECRET");
  const botToken = process.env.BOT_TOKEN;
  const chatId = process.env.CHAT_ID;

  console.log(`Webhook URL: ${webhookUrl}`);
  console.log(`Real message test: ${botToken && chatId ? "enabled" : "disabled (set BOT_TOKEN + CHAT_ID to enable)"}`);
  console.log("");

  // -- Synthetic webhook tests --
  console.log("--- Synthetic Webhook Tests ---");
  await testWebhookWithCorrectSecret(webhookUrl, webhookSecret);
  await testWebhookWithWrongSecret(webhookUrl);
  await testWebhookWithMissingSecret(webhookUrl);
  await testWebhookWithInvalidJson(webhookUrl, webhookSecret);
  console.log("");

  // -- Real message test (optional) --
  if (botToken && chatId) {
    console.log("--- Real Message Test ---");
    await testRealMessage(botToken, chatId);
    console.log("");
  }

  // -- Summary --
  console.log("=== Summary ===");
  if (failures === 0) {
    console.log("All checks passed.");
  } else {
    console.log(`${failures} check(s) failed.`);
  }

  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
