/**
 * Members queue scheduling & posting.
 *
 * Rules (from product):
 * - Priority over admin queue
 * - If admin already posted today → no members today (tomorrow+)
 * - Else up to 4 members posts/day
 * - Immediate post if a slot is free now; else schedule 10–22 MSK and notify author
 * - Notify only when going to wait/queue (not if posted immediately)
 */
import { Bot, InputFile } from "grammy";
import { assertAdminId, assertBotToken, config } from "../config.js";
import {
  adminCanPostToday,
  getDayRecord,
  incrementDayPost,
  membersSlotsLeftToday,
} from "../scheduler/dayState.js";
import {
  addDays,
  formatLocal,
  localDayString,
  localDateTime,
  randomPostAt,
  wallClock,
} from "../queue/time.js";
import {
  countMembersActive,
  getMemberItem,
  getMembersScheduled,
  listMembersActive,
  listMembersQueued,
  loadMembersQueue,
  updateMemberItem,
} from "./store.js";

/**
 * @param {import('grammy').Api} api
 * @param {string|number} chatId
 * @param {import('./store.js').MemberItem} item
 */
/**
 * Build InputMedia[] for album (mixed photo/video, caption on first).
 * @param {import('./store.js').MemberItem} item
 * @param {boolean} [withCaption]
 */
export function memberItemToInputMedia(item, withCaption = true) {
  const caption = withCaption ? item.caption || undefined : undefined;
  return item.media.map((m, i) => {
    const isFirst = i === 0;
    const type = m.mediaType === "video" ? "video" : "photo";
    return {
      type,
      media: m.fileId,
      ...(isFirst && caption ? { caption } : {}),
    };
  });
}

export async function publishMemberItem(api, chatId, item) {
  const caption = item.caption || undefined;
  if (!item.media?.length) {
    throw new Error("member item has no media");
  }
  if (item.media.length === 1) {
    const m = item.media[0];
    if (m.mediaType === "video") {
      return api.sendVideo(chatId, m.fileId, { caption });
    }
    return api.sendPhoto(chatId, m.fileId, { caption });
  }

  // 2–10 mixed photo/video album (Telegram media group)
  const media = memberItemToInputMedia(item, true);
  const msgs = await api.sendMediaGroup(chatId, media);
  return msgs[0];
}

/**
 * After ingest: try immediate post or schedule + optional author notify.
 * @param {import('./store.js').MemberItem} item
 * @param {import('grammy').Bot} bot
 * @param {{ replyChatId?: string|number }} [opts] chat to notify (monoforum / DM)
 */
export async function placeMemberItem(item, bot, opts = {}) {
  const tz = config.timeZone;
  const channelId = config.groupChatId;
  if (!channelId) throw new Error("GROUP_CHAT_ID missing");
  const replyChatId = opts.replyChatId;

  const today = localDayString(tz);
  const dayRec = await getDayRecord(today);
  const slots = membersSlotsLeftToday(dayRec);
  const { hour } = wallClock(tz);

  // Immediate if slot free and still within posting window (before 22:00)
  if (slots > 0 && hour < 22) {
    try {
      const msg = await publishMemberItem(bot.api, channelId, item);
      await updateMemberItem(item.id, {
        status: "posted",
        postedAt: new Date().toISOString(),
        postedMessageId: msg.message_id,
        postDay: today,
        authorNotified: false, // no queue notify on immediate
      });
      await incrementDayPost("members", today);
      return {
        mode: "immediate",
        postAt: null,
        messageId: msg.message_id,
      };
    } catch (err) {
      console.error("members immediate post failed, queueing", err);
      // fall through to schedule
    }
  }

  // Schedule: find next day with free members slots
  let day = today;
  // if no slots today or after 22:00, start tomorrow
  if (slots <= 0 || hour >= 22) {
    day = addDays(today, 1);
  }

  // Walk forward until a day without admin posts and members < 4
  for (let i = 0; i < 60; i++) {
    const rec = await getDayRecord(day);
    // days with admin posts are blocked for members
    if ((rec.admin || 0) > 0) {
      day = addDays(day, 1);
      continue;
    }
    // count already scheduled members for that day
    const { items } = await loadMembersQueue();
    const scheduledThatDay = items.filter(
      (x) =>
        (x.status === "scheduled" || x.status === "posted") &&
        x.postDay === day,
    ).length;
    // for "posted" today already in dayRec; for future days use scheduled count
    const used =
      day === today ? rec.members || 0 : scheduledThatDay;
    if (used < 4) {
      break;
    }
    day = addDays(day, 1);
  }

  let postAt;
  if (day === today && hour < 22) {
    // random later today if still time; if before 10, random in full window
    if (hour < 10) {
      postAt = randomPostAt(day, tz);
    } else {
      // random between now+5min and 22:00
      const start = new Date(Date.now() + 5 * 60 * 1000);
      const end = localDateTime(day, 22, 0, tz);
      if (start >= end) {
        day = addDays(day, 1);
        postAt = randomPostAt(day, tz);
      } else {
        const t =
          start.getTime() +
          Math.random() * (end.getTime() - start.getTime());
        postAt = new Date(t);
      }
    }
  } else {
    postAt = randomPostAt(day, tz);
  }

  await updateMemberItem(item.id, {
    status: "scheduled",
    postDay: day,
    postAt: postAt.toISOString(),
  });

  // Author gets a random film phrase (no queue ETA spam). Admin gets a quiet log.
  const { randomReplyPhrase } = await import("../replyPhrases.js");
  const phrase = randomReplyPhrase();

  try {
    const adminId = assertAdminId();
    await bot.api.sendMessage(
      adminId,
      `👥 Members queue +1 (waiting)\n` +
        (item.fromUsername ? `@${item.fromUsername}\n` : "") +
        `when: ${formatLocal(postAt, tz)}\n` +
        `id: <code>${item.id}</code>`,
      { parse_mode: "HTML" },
    );
  } catch {
    /* ignore */
  }

  let authorNotified = false;
  if (replyChatId) {
    try {
      await bot.api.sendMessage(replyChatId, phrase);
      authorNotified = true;
    } catch {
      /* ignore */
    }
  }
  if (!authorNotified && item.fromUserId) {
    try {
      await bot.api.sendMessage(item.fromUserId, phrase);
      authorNotified = true;
    } catch {
      /* ignore */
    }
  }
  await updateMemberItem(item.id, { authorNotified });

  return { mode: "scheduled", postAt, messageId: null, phrase };
}

/**
 * Tick: post due members items (up to remaining slots), schedule nothing extra.
 * @param {object} [opts]
 * @param {import('grammy').Bot} [opts.bot]
 */
export async function processMembersTick(opts = {}) {
  const bot = opts.bot || new Bot(assertBotToken());
  if (!opts.bot) await bot.init();

  const tz = config.timeZone;
  const channelId = config.groupChatId;
  const summary = { actions: [], posted: 0 };

  if (!channelId) {
    summary.actions.push("no_channel");
    return summary;
  }

  const { items } = await loadMembersQueue();
  const due = items
    .filter(
      (i) =>
        i.status === "scheduled" &&
        i.postAt &&
        new Date(i.postAt).getTime() <= Date.now(),
    )
    .sort((a, b) => (a.postAt < b.postAt ? -1 : 1));

  for (const item of due) {
    const day = item.postDay || localDayString(tz);
    const rec = await getDayRecord(day);
    // safety: don't post members on admin day
    if ((rec.admin || 0) > 0) {
      // push to next day
      const nextDay = addDays(day, 1);
      const postAt = randomPostAt(nextDay, tz);
      await updateMemberItem(item.id, {
        postDay: nextDay,
        postAt: postAt.toISOString(),
      });
      summary.actions.push(`defer_admin_day:${item.id}`);
      continue;
    }
    if (membersSlotsLeftToday(rec) <= 0 && day === localDayString(tz)) {
      const nextDay = addDays(day, 1);
      const postAt = randomPostAt(nextDay, tz);
      await updateMemberItem(item.id, {
        postDay: nextDay,
        postAt: postAt.toISOString(),
      });
      summary.actions.push(`defer_full:${item.id}`);
      continue;
    }

    try {
      const msg = await publishMemberItem(bot.api, channelId, item);
      await updateMemberItem(item.id, {
        status: "posted",
        postedAt: new Date().toISOString(),
        postedMessageId: msg.message_id,
      });
      await incrementDayPost("members", day);
      summary.posted += 1;
      summary.actions.push(`posted:${item.id}`);
    } catch (err) {
      summary.actions.push(`post_error:${err.message}`);
      console.error("members post failed", err);
      break;
    }
  }

  return summary;
}

export async function cancelMemberItem(id) {
  const item = await getMemberItem(id);
  if (!item) return { ok: false, error: "not_found" };
  if (item.status === "posted") return { ok: false, error: "already_posted" };
  // Hard-delete so browser / list cannot show stale "cancelled" as still present
  const { removeMemberItem } = await import("./store.js");
  const removed = await removeMemberItem(id);
  if (!removed) {
    // fallback soft-cancel
    await updateMemberItem(id, { status: "cancelled" });
  }
  return { ok: true };
}

export async function postMemberNow(id, bot) {
  const item = await getMemberItem(id);
  if (!item) return { ok: false, error: "not_found" };
  if (item.status === "posted") return { ok: false, error: "already_posted" };
  if (item.status === "cancelled") return { ok: false, error: "cancelled" };

  const channelId = config.groupChatId;
  if (!channelId) return { ok: false, error: "no_channel" };

  const tz = config.timeZone;
  const today = localDayString(tz);
  const rec = await getDayRecord(today);
  // force post even if limits? user post-now from admin browser — allow
  try {
    const msg = await publishMemberItem(bot.api, channelId, item);
    await updateMemberItem(id, {
      status: "posted",
      postedAt: new Date().toISOString(),
      postedMessageId: msg.message_id,
      postDay: today,
    });
    await incrementDayPost("members", today);
    return { ok: true, messageId: msg.message_id };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

export async function membersQueueStatusText() {
  const { items } = await loadMembersQueue();
  const active = countMembersActive(items);
  const scheduled = getMembersScheduled(items);
  const posted = items.filter((i) => i.status === "posted").length;
  const lines = [
    "<b>👥 Members queue</b>",
    `In queue: <b>${active}</b>`,
    `Posted: ${posted}`,
  ];
  if (scheduled) {
    lines.push(
      "",
      "<b>Next:</b>",
      `id: <code>${scheduled.id}</code>`,
      `day: ${scheduled.postDay || "—"}`,
      `time: ${scheduled.postAt ? formatLocal(scheduled.postAt, config.timeZone) : "—"}`,
      scheduled.fromUsername ? `from: @${scheduled.fromUsername}` : "",
    );
  }
  lines.push(
    "",
    "Source: channel Direct Messages.",
    "Priority over admin queue · up to 4/day · no admin post that day.",
  );
  return lines.filter(Boolean).join("\n");
}
