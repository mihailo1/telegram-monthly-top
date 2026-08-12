/**
 * Queue tick: schedule next photo, notify admin (day before), post at random time.
 *
 * Flow:
 * 1. At most one item status=scheduled (next to go live).
 * 2. postDay = tomorrow when scheduled in the evening/day; random postAt in [10:00, 22:00) local.
 * 3. Notify admin once with photo + ❌ cancel.
 * 4. When now >= postAt → post to channel, mark posted, promote next queued.
 */
import fs from "node:fs";
import path from "node:path";
import { Bot, InlineKeyboard } from "grammy";
import { assertAdminId, assertBotToken, config } from "../config.js";
import {
  countMembersActive,
  loadMembersQueue,
} from "../members/store.js";
import {
  adminCanPostToday,
  getDayRecord,
  incrementDayPost,
} from "../scheduler/dayState.js";
import {
  countActive,
  getItem,
  getScheduled,
  itemMediaType,
  listQueued,
  loadQueue,
  saveQueue,
  updateItem,
} from "./store.js";
import {
  addDays,
  formatLocal,
  localDayString,
  randomPostAt,
  wallClock,
} from "./time.js";

/**
 * @param {import('grammy').Bot} bot
 * @param {string|number} chatId
 * @param {import('./store.js').QueueItem} item
 * @param {object} [extra] caption, reply_markup, parse_mode
 */
export async function sendQueueMedia(bot, chatId, item, extra = {}) {
  const type = itemMediaType(item);
  if (type === "video") {
    return bot.api.sendVideo(chatId, item.fileId, extra);
  }
  return bot.api.sendPhoto(chatId, item.fileId, extra);
}

/**
 * @param {object} [opts]
 * @param {import('grammy').Bot} [opts.bot]
 * @returns {Promise<object>} summary of actions
 */
export async function processQueueTick(opts = {}) {
  const bot = opts.bot || new Bot(assertBotToken());
  if (!opts.bot) {
    // lightweight init for standalone cron
    await bot.init();
  }

  const adminId = assertAdminId();
  const tz = config.timeZone;
  const channelId = config.groupChatId;
  const summary = {
    actions: /** @type {string[]} */ ([]),
    active: 0,
    scheduled: null,
  };

  let state = await loadQueue();
  summary.active = countActive(state);

  // Members queue has priority: while any members item is active, pause admin posts
  const membersState = await loadMembersQueue();
  const membersActive = countMembersActive(membersState.items);
  if (membersActive > 0) {
    summary.actions.push(`admin_paused_members:${membersActive}`);
  }

  // --- Post if due (admin) ---
  let scheduled = getScheduled(state);
  if (
    membersActive === 0 &&
    scheduled?.postAt &&
    new Date(scheduled.postAt).getTime() <= Date.now()
  ) {
    const today = localDayString(tz);
    const dayRec = await getDayRecord(today);
    if (!adminCanPostToday(dayRec)) {
      const nextDay = addDays(today, 1);
      const postAt = randomPostAt(nextDay, tz);
      await updateItem(scheduled.id, {
        postDay: nextDay,
        postAt: postAt.toISOString(),
        notified: false,
      });
      summary.actions.push(`admin_defer_day:${scheduled.id}`);
    } else {
      const postResult = await postScheduledNow(scheduled.id, bot, {
        notifyAdmin: true,
      });
      if (!postResult.ok) {
        summary.actions.push(`post_error:${postResult.error}`);
        if (postResult.error !== "no_channel") {
          return summary;
        }
      } else {
        summary.actions.push(`posted:${scheduled.id}`);
      }
    }
    state = await loadQueue();
    scheduled = getScheduled(state);
  }

  // --- Ensure one scheduled item (admin) only if members queue empty ---
  state = await loadQueue();
  scheduled = getScheduled(state);
  if (!scheduled && membersActive === 0) {
    const queued = listQueued(state);
    if (queued.length === 0) {
      summary.actions.push("queue_empty");
      summary.active = 0;
      return summary;
    }

    const next = queued[0];
    const today = localDayString(tz);
    let postDay = addDays(today, 1);
    for (let i = 0; i < 60; i++) {
      const rec = await getDayRecord(postDay);
      if ((rec.members || 0) === 0 && (rec.admin || 0) === 0) break;
      postDay = addDays(postDay, 1);
    }

    const postAt = randomPostAt(postDay, tz);
    await updateItem(next.id, {
      status: "scheduled",
      postDay,
      postAt: postAt.toISOString(),
      notified: false,
    });
    summary.actions.push(`scheduled:${next.id}@${postAt.toISOString()}`);
    state = await loadQueue();
    scheduled = getScheduled(state);
  } else if (membersActive > 0 && !scheduled) {
    summary.actions.push("admin_not_scheduled_members_pending");
  }

  // --- Notify admin once about scheduled media (claim lock to avoid duplicates) ---
  if (scheduled && !scheduled.notified) {
    const claimed = await tryClaimNotify(scheduled.id);
    if (!claimed) {
      summary.actions.push(`notify_skip_race:${scheduled.id}`);
    } else {
      try {
        const when = formatLocal(scheduled.postAt, tz);
        const keyboard = new InlineKeyboard()
          .text("✅ Post now", `qpostnow:${scheduled.id}`)
          .text("❌ Cancel", `qcancel:${scheduled.id}`);
        const inQueue = countActive(await loadQueue());
        const caption = [
          `📅 <b>Next post to channel</b> (@${config.channelUsername})`,
          `When: <b>${when}</b> (${tz})`,
          `Still in queue: <b>${Math.max(0, inQueue - 1)}</b>`,
          `id: <code>${scheduled.id}</code>`,
          "",
          "✅ Post now — publish immediately, advance queue",
          "❌ Cancel — drop this item, promote next",
        ].join("\n");

        const msg = await sendQueueMedia(bot, adminId, scheduled, {
          caption,
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
        await updateItem(scheduled.id, {
          notified: true,
          notifyMessageId: msg.message_id,
        });
        summary.actions.push(`notified:${scheduled.id}`);
      } catch (err) {
        // allow retry next tick
        await updateItem(scheduled.id, { notified: false });
        await releaseNotifyClaim(scheduled.id);
        summary.actions.push(`notify_error:${err.message}`);
        console.error("queue notify failed", err);
      }
    }
  }

  state = await loadQueue();
  summary.active = countActive(state);
  summary.scheduled = getScheduled(state)
    ? {
        id: getScheduled(state).id,
        postAt: getScheduled(state).postAt,
        postDay: getScheduled(state).postDay,
        notified: getScheduled(state).notified,
      }
    : null;

  return summary;
}

async function tryClaimNotify(itemId) {
  const item = await getItem(itemId);
  if (!item || item.notified) return false;

  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (
    process.env.BLOB_READ_WRITE_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN
  ) {
    try {
      const { list, put } = await import("../storage/blob.js");
      const pathname = `queue/notify-lock/${itemId}.json`;
      const existing = await list({ prefix: pathname });
      if (existing.blobs.some((b) => b.pathname === pathname)) return false;
      await put(pathname, JSON.stringify({ token, at: Date.now() }), {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: false,
      });
      await updateItem(itemId, { notified: true, notifyClaimToken: token });
      return true;
    } catch {
      return false;
    }
  }

  const dir = path.resolve("./data/queue/notify-lock");
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, `${itemId}.json`);
  try {
    fs.writeFileSync(lockFile, JSON.stringify({ token }), { flag: "wx" });
  } catch {
    return false;
  }
  await updateItem(itemId, { notified: true, notifyClaimToken: token });
  return true;
}

async function releaseNotifyClaim(itemId) {
  if (
    process.env.BLOB_READ_WRITE_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN
  ) {
    try {
      const { list, del } = await import("../storage/blob.js");
      const pathname = `queue/notify-lock/${itemId}.json`;
      const existing = await list({ prefix: pathname });
      for (const b of existing.blobs) {
        if (b.pathname === pathname) await del(b.pathname || b.url);
      }
    } catch {
      /* ignore */
    }
    return;
  }
  const lockFile = path.resolve(`./data/queue/notify-lock/${itemId}.json`);
  try {
    fs.unlinkSync(lockFile);
  } catch {
    /* ignore */
  }
}

/**
 * Post a scheduled (or any active) queue item to the channel right now,
 * then promote the next queued item (schedule + notify).
 *
 * @param {string} id
 * @param {import('grammy').Bot} bot
 * @param {{ notifyAdmin?: boolean }} [opts]
 */
export async function postScheduledNow(id, bot, opts = {}) {
  const notifyAdmin = opts.notifyAdmin !== false;
  const channelId = config.groupChatId;
  if (!channelId) return { ok: false, error: "no_channel" };

  const state = await loadQueue();
  const item = state.items.find((i) => i.id === id);
  if (!item) return { ok: false, error: "not_found" };
  if (item.status === "posted") return { ok: false, error: "already_posted" };
  if (item.status === "cancelled") return { ok: false, error: "already_cancelled" };
  // Allow post-now for scheduled (primary) or first queued if id matches
  if (item.status !== "scheduled" && item.status !== "queued") {
    return { ok: false, error: "bad_status" };
  }

  try {
    const msg = await sendQueueMedia(bot, channelId, item);
    await updateItem(item.id, {
      status: "posted",
      postedAt: new Date().toISOString(),
      postedMessageId: msg.message_id,
    });
    try {
      await incrementDayPost("admin", localDayString(config.timeZone));
    } catch (err) {
      console.warn("day state increment failed", err.message);
    }

    if (notifyAdmin) {
      try {
        const adminId = assertAdminId();
        await bot.api.sendMessage(
          adminId,
          `✅ Posted to @${config.channelUsername}\n` +
            `<a href="https://t.me/${config.channelUsername}/${msg.message_id}">open</a>\n` +
            `id: <code>${item.id}</code>`,
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
        );
      } catch {
        /* ignore */
      }
    }

    // Promote next: schedule + notify
    const summary = await processQueueTick({ bot });
    return {
      ok: true,
      messageId: msg.message_id,
      promoted: summary.scheduled,
    };
  } catch (err) {
    console.error("postScheduledNow failed", err);
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Cancel scheduled/queued item; if it was scheduled, promote next.
 * @param {string} id
 * @param {import('grammy').Bot} [bot]
 */
export async function cancelQueueItem(id, bot) {
  const state = await loadQueue();
  const item = state.items.find((i) => i.id === id);
  if (!item) return { ok: false, error: "not_found" };
  if (item.status === "posted") return { ok: false, error: "already_posted" };
  if (item.status === "cancelled") return { ok: false, error: "already_cancelled" };

  const wasScheduled = item.status === "scheduled";
  item.status = "cancelled";
  await saveQueue(state);

  let promoted = null;
  if (wasScheduled) {
    // Immediately schedule next + notify via tick
    const summary = await processQueueTick({ bot });
    promoted = summary.scheduled;
  }

  return { ok: true, wasScheduled, promoted };
}

/**
 * Human-readable queue status for /queue
 */
export async function queueStatusText() {
  const state = await loadQueue();
  const tz = config.timeZone;
  const active = state.items.filter(
    (i) => i.status === "queued" || i.status === "scheduled",
  );
  const scheduled = getScheduled(state);
  const posted = state.items.filter((i) => i.status === "posted").length;
  const cancelled = state.items.filter((i) => i.status === "cancelled").length;

  const lines = [
    "<b>Admin queue</b>",
    `In queue: <b>${active.length}</b>`,
    `Posted total: ${posted}`,
    `Cancelled: ${cancelled}`,
  ];

  if (scheduled) {
    lines.push(
      "",
      "<b>Next post:</b>",
      `id: <code>${scheduled.id}</code>`,
      `day: ${scheduled.postDay || "—"}`,
      `time: ${scheduled.postAt ? formatLocal(scheduled.postAt, tz) : "—"}`,
      `notified: ${scheduled.notified ? "yes" : "no"}`,
    );
  } else {
    lines.push("", "No next post scheduled (queue empty or waiting for tick).");
  }

  lines.push(
    "",
    "Send <b>photos or videos</b> in DM — they go to the <b>end</b> of the queue.",
    "1 media / day · 10:00–22:00 · notify with ✅ post now / ❌ cancel.",
  );

  return lines.join("\n");
}
