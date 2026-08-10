/**
 * Telegram bot webhook (Vercel serverless).
 * Set with: PUBLIC_URL=https://….vercel.app npm run set-webhook
 *
 * Note: on serverless we must `await bot.init()` before handleUpdate,
 * otherwise grammY throws "Bot not initialized!".
 */
import { createBot, setupBotMenu } from "../src/botApp.js";
import { config as appConfig } from "../src/config.js";

export const config = {
  // Preview button may wait on /api/preview (up to ~55s)
  maxDuration: 60,
};

const bot = createBot();
/** @type {Promise<void> | null} */
let initPromise = null;

function ensureInit() {
  if (!initPromise) {
    initPromise = (async () => {
      await bot.init();
      try {
        await setupBotMenu(bot);
      } catch (err) {
        console.warn("setMyCommands failed:", err.message ?? err);
      }
    })();
  }
  return initPromise;
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    res.status(200).json({ ok: true, service: "telegram-monthly-top webhook" });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "method not allowed" });
    return;
  }

  if (appConfig.webhookSecret) {
    const q = req.query?.secret;
    if (q !== appConfig.webhookSecret) {
      res.status(401).json({ ok: false, error: "bad webhook secret" });
      return;
    }
  }

  try {
    await ensureInit();
    // Vercel parses JSON body already
    await bot.handleUpdate(req.body);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("webhook error", err);
    // Reset init on failure so next cold start can retry getMe
    initPromise = null;
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  }
}
