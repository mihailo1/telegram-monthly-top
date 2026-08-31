/**
 * Twice-daily tick: resolve due monthly-poll → avatar jobs.
 * Split out from queue-cron (which ticks every 15m) since a 5-day delay
 * doesn't need 15-minute resolution — see .github/workflows/avatar-tick.yml.
 *
 * Auth: x-vercel-cron OR ?secret=CRON_SECRET
 */
import { Bot } from "grammy";
import { assertBotToken, config as appConfig } from "../src/config.js";
import { processAvatarJobs } from "../src/monthly/avatarJob.js";

export const config = {
  maxDuration: 60,
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
    const bot = new Bot(assertBotToken());
    await bot.init();
    const avatar = await processAvatarJobs({ bot });
    res.status(200).json({ ok: true, avatar });
  } catch (err) {
    console.error("avatar-cron failed", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
