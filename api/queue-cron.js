/**
 * Frequent tick: members monoforum poll + members post + admin queue.
 * Monthly poll → avatar runs on its own, less frequent cron — see api/avatar-cron.js.
 * Auth: Authorization: Bearer CRON_SECRET (Vercel Cron sends it) OR ?secret=CRON_SECRET
 */
import { Bot } from "grammy";
import { assertBotToken, config as appConfig } from "../src/config.js";
import { processArchiveTick } from "../src/archive/tick.js";
import { checkDeployNotice } from "../src/deployNotice.js";
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

    // 0) Tell the admin about a fresh deployment (once per deployment)
    let deployNotice = false;
    try {
      deployNotice = await checkDeployNotice(bot);
    } catch (err) {
      console.error("deploy notice failed", err);
    }

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

    // 4) Sunday archive draft (no-op on other days)
    let archive = [];
    try {
      archive = await processArchiveTick({ bot });
    } catch (err) {
      archive = [`archive_throw:${err.message}`];
    }

    res.status(200).json({ ok: true, deployNotice, poll, members, admin, archive });
  } catch (err) {
    console.error("queue-cron failed", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
