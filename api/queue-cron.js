/**
 * Frequent tick: members monoforum poll + members post + admin queue.
 * Auth: x-vercel-cron OR ?secret=CRON_SECRET
 */
import { Bot } from "grammy";
import { assertBotToken, config as appConfig } from "../src/config.js";
import { pollChannelDirectMessages } from "../src/members/pollMonoforum.js";
import { processMembersTick } from "../src/members/process.js";
import { processQueueTick } from "../src/queue/process.js";

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

    // 1) Pull new channel DMs into members queue
    let poll = { scanned: 0, ingested: 0, actions: ["skipped"] };
    try {
      poll = await pollChannelDirectMessages();
    } catch (err) {
      poll = { scanned: 0, ingested: 0, actions: [`poll_throw:${err.message}`] };
    }

    // 2) Post due members (priority)
    const members = await processMembersTick({ bot });

    // 3) Admin queue (paused while members active)
    const admin = await processQueueTick({ bot });

    res.status(200).json({ ok: true, poll, members, admin });
  } catch (err) {
    console.error("queue-cron failed", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
