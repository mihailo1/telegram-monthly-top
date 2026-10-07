/**
 * Admin DM alerts for the admin queue, deduplicated across cron ticks.
 *
 * A tick can only alert when it actually runs. A tick that never fires
 * can't report itself, so checkQueueAlerts is also called from avatar-cron,
 * which has independent triggers (GitHub + Vercel native cron).
 */
import fs from "node:fs";
import path from "node:path";
import { Bot } from "grammy";
import { assertAdminId, assertBotToken, config } from "./config.js";
import { countMembersActive, loadMembersQueue } from "./members/store.js";
import { countActive, getScheduled, loadQueue } from "./queue/store.js";
import { formatLocal, localDayString } from "./queue/time.js";
import { getJson, put as storePut } from "./storage/blob.js";

const LOCAL_PATH = path.resolve("./data/alerts.json");
const BLOB_KEY = "scheduler/alerts.json";
const KEEP_MS = 35 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const OVERDUE_MS = Number(process.env.ALERT_OVERDUE_MIN || 45) * 60 * 1000;
const LOW_QUEUE = Number(process.env.ALERT_LOW_QUEUE || 3);

function useRemote() {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN ||
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN,
  );
}

/** @returns {Promise<{ sent: Record<string, string>, muted?: Record<string, boolean> }>} */
async function loadAlertState() {
  try {
    if (useRemote()) return await getJson(BLOB_KEY);
    return JSON.parse(fs.readFileSync(LOCAL_PATH, "utf8"));
  } catch {
    return { sent: {} };
  }
}

async function saveAlertState(state) {
  const body = JSON.stringify(state, null, 2);
  if (useRemote()) {
    await storePut(BLOB_KEY, body, {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return;
  }
  fs.mkdirSync(path.dirname(LOCAL_PATH), { recursive: true });
  fs.writeFileSync(LOCAL_PATH, body, "utf8");
}

/**
 * Send an alert unless the same key fired within the cooldown.
 * The key is saved before sending so a failed save can't cause a repeat
 * every 15 minutes; a failed send releases the key for the next tick.
 * @returns {Promise<boolean>} true if sent
 */
export async function sendAlertOnce(bot, key, text, cooldownMs, opts = {}) {
  const state = await loadAlertState();
  if (opts.category && state.muted?.[opts.category]) return false;
  const sent = state.sent || {};
  const last = sent[key] ? new Date(sent[key]).getTime() : 0;
  if (Date.now() - last < cooldownMs) return false;

  const now = Date.now();
  for (const [k, at] of Object.entries(sent)) {
    if (now - new Date(at).getTime() > KEEP_MS) delete sent[k];
  }
  sent[key] = new Date(now).toISOString();
  await saveAlertState({ ...state, sent });

  try {
    await bot.api.sendMessage(assertAdminId(), text, {
      parse_mode: "HTML",
      disable_notification: Boolean(opts.silent),
      link_preview_options: { is_disabled: true },
    });
    return true;
  } catch (err) {
    console.error("alert send failed", key, err.message);
    delete sent[key];
    await saveAlertState({ ...state, sent }).catch(() => {});
    return false;
  }
}

/** Alert categories the admin switched off from the menu. */
export async function getMuted() {
  return (await loadAlertState()).muted || {};
}

/** @returns {Promise<boolean>} true if the category is now muted */
export async function toggleMuted(category) {
  const state = await loadAlertState();
  const muted = { ...(state.muted || {}) };
  muted[category] = !muted[category];
  await saveAlertState({ sent: state.sent || {}, ...state, muted });
  return muted[category];
}

function formatDuration(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Overdue post, empty queue, running-low queue.
 * @param {object} [opts]
 * @param {import('grammy').Bot} [opts.bot]
 * @param {object} [opts.state] preloaded admin queue state
 * @param {number} [opts.membersActive] preloaded active members item count
 * @returns {Promise<string[]>} keys of alerts that were sent
 */
export async function checkQueueAlerts(opts = {}) {
  const bot = opts.bot || new Bot(assertBotToken());
  const tz = config.timeZone;
  const state = opts.state || (await loadQueue());
  const membersActive =
    opts.membersActive ??
    countMembersActive((await loadMembersQueue()).items);

  const fired = [];
  const fire = async (key, text, cooldownMs, o) => {
    if (await sendAlertOnce(bot, key, text, cooldownMs, o)) fired.push(key);
  };

  const scheduled = getScheduled(state);
  if (scheduled?.postAt) {
    const late = Date.now() - new Date(scheduled.postAt).getTime();
    if (late >= OVERDUE_MS) {
      await fire(
        `overdue:${scheduled.id}:${scheduled.postAt}`,
        [
          `⏰ <b>Post is ${formatDuration(late)} overdue</b>`,
          `Was due: ${formatLocal(scheduled.postAt, tz)} (${tz})`,
          membersActive > 0
            ? `Admin posts are paused while ${membersActive} members item(s) are active.`
            : "No tick posted it. The cron trigger may have stopped, check cron-job.org.",
          `id: <code>${scheduled.id}</code>`,
        ].join("\n"),
        KEEP_MS,
      );
    }
  }

  const active = countActive(state);
  if (active === 0 && membersActive === 0) {
    await fire(
      `empty:${localDayString(tz)}`,
      "📭 <b>Queue is empty</b>\nNothing will be posted tomorrow. Send photos to the bot to refill.",
      20 * HOUR_MS,
    );
  } else if (active > 0 && active <= LOW_QUEUE) {
    await fire(
      "low",
      `🪫 <b>Queue is running low</b>\n${active} item(s) left, about ${active} day(s) of posts.`,
      24 * HOUR_MS,
      { silent: true, category: "low" },
    );
  }

  return fired;
}

/**
 * Alert when posting to the channel fails (bad file_id, bot removed, etc).
 * One alert per item per day.
 */
export async function alertPostError(bot, itemId, error) {
  await sendAlertOnce(
    bot,
    `posterr:${itemId}:${localDayString(config.timeZone)}`,
    [
      "🚫 <b>Posting to the channel failed</b>",
      `<code>${escapeHtml(String(error).slice(0, 300))}</code>`,
      `id: <code>${itemId}</code>`,
      "The item stays scheduled and retries on the next tick.",
    ].join("\n"),
    24 * HOUR_MS,
  );
}
