/**
 * Vercel Cron + manual monthly preview → admin DM.
 * Schedule: vercel.json → 06:00 UTC on the 5th (~09:00 MSK).
 * Sends monthly top preview to ADMIN_ID for ✅/❌ approval.
 *
 * Auth: Authorization: Bearer CRON_SECRET  OR  ?secret=CRON_SECRET
 * Vercel Cron sends header x-vercel-cron: 1
 */
import { Bot } from "grammy";
import { assertAdminId, assertBotToken, config as appConfig } from "../src/config.js";
import { runMonthlyPreview } from "../src/runPreview.js";

export const config = {
  maxDuration: 60,
  memory: 1024,
};

function authorized(req) {
  const secret = appConfig.cronSecret;
  const auth = req.headers?.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const q = req.query?.secret || "";
  const isVercelCron = req.headers?.["x-vercel-cron"] === "1";

  if (isVercelCron) return true;
  if (!secret) return !appConfig.isVercel;
  return bearer === secret || q === secret;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ ok: false, error: "method not allowed" });
    return;
  }

  if (!authorized(req)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  try {
    const result = await runMonthlyPreview({ interactive: false });
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("cron preview failed", err);
    try {
      const bot = new Bot(assertBotToken());
      await bot.api.sendMessage(
        assertAdminId(),
        `⚠️ Monthly preview crashed — no draft/buttons were created.\n${String(err.message || err).slice(0, 500)}`,
      );
    } catch (notifyErr) {
      console.error("failed to notify admin of cron failure", notifyErr);
    }
    res.status(500).json({
      ok: false,
      error: String(err.message || err),
    });
  }
}
