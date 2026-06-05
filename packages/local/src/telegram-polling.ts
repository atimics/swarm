/**
 * Local Telegram Bot Polling Service
 *
 * Polls Telegram's getUpdates API and routes messages
 * through the admin chat pipeline when running locally.
 */
import { Bot } from "grammy";

export interface TelegramPollingDeps {
  getToken: () => Promise<string | null>;
  processMessage: (text: string, chatId: string, username: string) => Promise<string>;
}

export function startTelegramPolling(deps: TelegramPollingDeps): () => void {
  let bot: Bot | null = null;
  let running = true;
  let lastUpdateId = 0;

  async function poll() {
    while (running) {
      try {
        const token = await deps.getToken();
        if (!token) { await sleep(10000); continue; }

        if (!bot || bot.token !== token) bot = new Bot(token);

        const updates = await bot.api.getUpdates({
          offset: lastUpdateId + 1, timeout: 30,
          allowed_updates: ["message"],
        });

        for (const u of updates) {
          lastUpdateId = u.update_id;
          const msg = u.message;
          if (!msg?.text) continue;
          const chatId = String(msg.chat.id);
          const username = msg.from?.username ?? msg.from?.first_name ?? "unknown";
          try {
            const resp = await deps.processMessage(msg.text, chatId, username);
            if (resp) await bot.api.sendMessage(chatId, resp.slice(0, 4096));
          } catch (err) {
            console.error("[local] Telegram msg error:", err);
            try { await bot.api.sendMessage(chatId, "Sorry, something went wrong."); } catch {}
          }
        }
      } catch (err) {
        console.error("[local] Telegram poll error:", err);
        await sleep(5000);
      }
    }
  }

  poll();
  return () => { running = false; };
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
