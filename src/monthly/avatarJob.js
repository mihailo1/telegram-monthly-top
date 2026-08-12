/**
 * After a monthly poll is live for N days, stop the poll, pick the winning
 * option, and set that photo as the channel profile picture.
 *
 * Requires bot admin right: can_change_info (Change channel info).
 */
import fs from "node:fs";
import path from "node:path";
import { Bot, InputFile } from "grammy";
import { assertAdminId, assertBotToken, config } from "../config.js";

const BLOB_PREFIX = "monthly/avatar-jobs/";
const LOCAL_DIR = path.resolve("./data/monthly/avatar-jobs");
const DEFAULT_DELAY_DAYS = Number(process.env.AVATAR_POLL_DELAY_DAYS || 5);

function useRemote() {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN ||
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN,
  );
}

/**
 * @typedef {object} AvatarJob
 * @property {string} id
 * @property {"pending"|"done"|"failed"|"skipped"} status
 * @property {string} createdAt
 * @property {string} processAfter   ISO — when to resolve (created + 5d)
 * @property {string} chatId         channel id
 * @property {string} channelUsername
 * @property {number} pollMessageId
 * @property {string[]} photoFileIds  index matches poll option 0..n-1
 * @property {string} [rangeLabel]
 * @property {string} [pollQuestion]
 * @property {number} [winnerIndex]
 * @property {number} [winnerVotes]
 * @property {string} [error]
 * @property {string} [completedAt]
 */

function jobPath(id) {
  return `${BLOB_PREFIX}${id}.json`;
}

/** @param {AvatarJob} job */
async function writeJob(job) {
  const body = JSON.stringify(job, null, 2);
  if (useRemote()) {
    const { put } = await import("../storage/blob.js");
    await put(jobPath(job.id), body, {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return;
  }
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOCAL_DIR, `${job.id}.json`), body, "utf8");
}

/** @returns {Promise<AvatarJob[]>} */
async function listJobs() {
  if (useRemote()) {
    try {
      const { list } = await import("../storage/blob.js");
      const result = await list({ prefix: BLOB_PREFIX });
      const jobs = [];
      for (const blob of result.blobs) {
        if (!blob.pathname.endsWith(".json")) continue;
        try {
          const { getJson } = await import("../storage/blob.js");
          jobs.push(await getJson(blob.pathname));
        } catch {
          /* skip */
        }
      }
      return jobs;
    } catch (err) {
      console.error("list avatar jobs", err.message);
      return [];
    }
  }
  if (!fs.existsSync(LOCAL_DIR)) return [];
  return fs
    .readdirSync(LOCAL_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(LOCAL_DIR, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Schedule avatar update after monthly poll publish.
 * @param {object} input
 * @param {string|number} input.chatId
 * @param {number} input.pollMessageId
 * @param {string[]} input.photoFileIds
 * @param {string} [input.channelUsername]
 * @param {string} [input.rangeLabel]
 * @param {string} [input.pollQuestion]
 * @param {number} [input.delayDays]
 * @param {string|Date} [input.processAfter] absolute time (overrides delayDays)
 * @param {string|Date} [input.createdAt] poll publish time for delayDays calc
 */
export async function scheduleAvatarJob(input) {
  const delayDays = input.delayDays ?? DEFAULT_DELAY_DAYS;
  const created = input.createdAt ? new Date(input.createdAt) : new Date();
  let processAfter;
  if (input.processAfter) {
    processAfter = new Date(input.processAfter);
  } else {
    processAfter = new Date(
      created.getTime() + delayDays * 24 * 60 * 60 * 1000,
    );
  }
  /** @type {AvatarJob} */
  const job = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    status: "pending",
    createdAt: created.toISOString(),
    processAfter: processAfter.toISOString(),
    chatId: String(input.chatId),
    channelUsername: input.channelUsername || config.channelUsername,
    pollMessageId: input.pollMessageId,
    photoFileIds: input.photoFileIds,
    rangeLabel: input.rangeLabel || "",
    pollQuestion: input.pollQuestion || "",
  };
  await writeJob(job);
  return job;
}

/**
 * Pick winning option index (highest voter_count; ties → lowest index).
 * @param {{ text: string, voter_count: number }[]} options
 */
export function pickWinnerIndex(options) {
  if (!options?.length) return -1;
  let best = 0;
  for (let i = 1; i < options.length; i++) {
    if ((options[i].voter_count || 0) > (options[best].voter_count || 0)) {
      best = i;
    }
  }
  return best;
}

/**
 * Process all due avatar jobs.
 * @param {object} [opts]
 * @param {import('grammy').Bot} [opts.bot]
 */
export async function processAvatarJobs(opts = {}) {
  const bot = opts.bot || new Bot(assertBotToken());
  if (!opts.bot) await bot.init();

  const now = Date.now();
  const jobs = await listJobs();
  const due = jobs.filter(
    (j) => j.status === "pending" && new Date(j.processAfter).getTime() <= now,
  );

  const summary = { checked: jobs.length, due: due.length, actions: [] };

  for (const job of due) {
    try {
      await resolveAvatarJob(bot, job);
      summary.actions.push(`done:${job.id}`);
    } catch (err) {
      console.error("avatar job failed", job.id, err);
      job.status = "failed";
      job.error = err.message || String(err);
      job.completedAt = new Date().toISOString();
      await writeJob(job);
      summary.actions.push(`failed:${job.id}:${job.error}`);
      try {
        await bot.api.sendMessage(
          assertAdminId(),
          `⚠️ Avatar job failed\n<code>${job.id}</code>\n${escapeHtml(job.error)}`,
          { parse_mode: "HTML" },
        );
      } catch {
        /* ignore */
      }
    }
  }

  return summary;
}

/**
 * @param {import('grammy').Bot} bot
 * @param {AvatarJob} job
 */
async function resolveAvatarJob(bot, job) {
  // Stop poll → final results (also closes voting)
  const poll = await bot.api.stopPoll(job.chatId, job.pollMessageId);
  const options = poll.options || [];
  const winnerIndex = pickWinnerIndex(options);

  if (winnerIndex < 0 || winnerIndex >= job.photoFileIds.length) {
    job.status = "skipped";
    job.error = "no_valid_winner";
    job.completedAt = new Date().toISOString();
    await writeJob(job);
    return;
  }

  const votes = options[winnerIndex].voter_count || 0;
  // If zero votes, still pick option 0 by tie-break — skip avatar if no votes at all
  const totalVotes = options.reduce((s, o) => s + (o.voter_count || 0), 0);
  if (totalVotes === 0) {
    job.status = "skipped";
    job.error = "no_votes";
    job.winnerIndex = winnerIndex;
    job.winnerVotes = 0;
    job.completedAt = new Date().toISOString();
    await writeJob(job);
    await notifyAdmin(
      bot,
      `⏭ Poll closed with 0 votes — channel avatar not changed.\n` +
        `poll: <code>${job.pollMessageId}</code>`,
    );
    return;
  }

  const fileId = job.photoFileIds[winnerIndex];

  // setChatPhoto requires multipart upload (file_id not allowed)
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("getFile returned no file_path");
  }
  const url = `https://api.telegram.org/file/bot${assertBotToken()}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download photo failed: HTTP ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  await bot.api.setChatPhoto(
    job.chatId,
    new InputFile(buffer, `winner_${winnerIndex}.jpg`),
  );

  job.status = "done";
  job.winnerIndex = winnerIndex;
  job.winnerVotes = votes;
  job.completedAt = new Date().toISOString();
  await writeJob(job);

  const label = options[winnerIndex]?.text || String(winnerIndex + 1);
  const link = job.channelUsername
    ? `https://t.me/${job.channelUsername}/${job.pollMessageId}`
    : "";
  await notifyAdmin(
    bot,
    [
      `🏆 Monthly poll resolved — channel avatar updated`,
      job.rangeLabel ? `period: ${job.rangeLabel}` : "",
      `winner: option <b>${label}</b> · ${votes} votes (index ${winnerIndex})`,
      link ? `<a href="${link}">poll</a>` : `poll msg: <code>${job.pollMessageId}</code>`,
      `job: <code>${job.id}</code>`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

async function notifyAdmin(bot, html) {
  try {
    await bot.api.sendMessage(assertAdminId(), html, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch {
    /* ignore */
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
