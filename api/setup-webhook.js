/**
 * Registers Telegram webhook → https://<host>/api/webhook
 * GET /api/setup-webhook?secret=CRON_SECRET
 */
import { Bot } from "grammy";
import {
  assertBotToken,
  assertPublicUrl,
  config as appConfig,
} from "../src/config.js";

export const config = {
  maxDuration: 10,
};

export default async function handler(req, res) {
  const secret = appConfig.cronSecret;
  if (secret) {
    const q = req.query?.secret;
    const auth = req.headers?.authorization || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (q !== secret && bearer !== secret) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
  }

  try {
    const base = assertPublicUrl();
    let webhookUrl = `${base}/api/webhook`;
    if (appConfig.webhookSecret) {
      webhookUrl += `?secret=${encodeURIComponent(appConfig.webhookSecret)}`;
    }

    const bot = new Bot(assertBotToken());
    await bot.api.setWebhook(webhookUrl, {
      drop_pending_updates: true,
      allowed_updates: ["message", "callback_query"],
    });
    const info = await bot.api.getWebhookInfo();
    res.status(200).json({ ok: true, webhookUrl, info });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
