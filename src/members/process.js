/**
 * Members queue scheduling & posting.
 *
 * Rules (from product):
 * - Priority over admin queue
 * - If admin already posted that day → no members that day (next free day)
 * - Else up to 4 members posts/day
 * - NEVER post to channel on ingest — always enqueue + schedule 10–22 APP_TZ
 * - Always reply author in channel DMs with a film phrase (not queue ETA)
 */
import { Bot, InputFile } from "grammy";
import { assertAdminId, assertBotToken, config } from "../config.js";
import {
  adminPostedOnDay,
  incrementDayPost,
  membersSlotsLeftOnDay,
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
 * Channel Direct Messages (monoforum) require direct_messages_topic_id.
 * Extract from Bot API Message (snake or camel depending on layer/grammy).
 * @param {object} [msg]
 * @returns {number|undefined}
 */
export function extractDirectMessagesTopicId(msg) {
  if (!msg || typeof msg !== "object") return undefined;
  const topic =
    msg.direct_messages_topic ||
    msg.directMessagesTopic ||
    null;
  const id =
    topic?.topic_id ??
    topic?.topicId ??
    msg.message_thread_id ??
    msg.messageThreadId;
  if (id == null || id === "") return undefined;
  const n = Number(id);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Send a random film phrase to the author (channel DM / monoforum / private).
 * Always used after they send photo(s) — not queue ETA text.
 * @param {import('grammy').Bot} bot
 * @param {{
 *   replyChatId?: string|number,
 *   fromUserId?: string|number,
 *   replyToMessageId?: number,
 *   directMessagesTopicId?: number,
 *   messageThreadId?: number,
 * }} opts
 * @returns {Promise<{ ok: boolean, phrase: string, error?: string }>}
 */
export async function replyAuthorWithPhrase(bot, opts = {}) {
  const { randomReplyPhrase } = await import("../replyPhrases.js");
  const phrase = randomReplyPhrase();
  const {
    replyChatId,
    fromUserId,
    replyToMessageId,
    directMessagesTopicId,
    messageThreadId,
  } = opts;

  /** @type {Record<string, unknown>} */
  const extra = {};
  if (replyToMessageId != null) {
    extra.reply_parameters = { message_id: replyToMessageId };
  }
  // Bot API 9+/10: required for channel Direct Messages chats
  if (directMessagesTopicId != null) {
    extra.direct_messages_topic_id = directMessagesTopicId;
  }
  // Forum / private topics fallback
  if (messageThreadId != null) {
    extra.message_thread_id = messageThreadId;
  } else if (directMessagesTopicId != null) {
    // some clients accept topic id as thread id
    extra.message_thread_id = directMessagesTopicId;
  }

  if (replyChatId) {
    try {
      // raw payload so unknown Bot API fields are not stripped by typings
      await bot.api.raw.sendMessage({
        chat_id: replyChatId,
        text: phrase,
        ...extra,
      });
      return { ok: true, phrase };
    } catch (err) {
      const msg = err?.message || String(err);
      console.warn("phrase via replyChatId failed", msg);
      // retry without reply_parameters (topic alone is enough for DM chats)
      if (extra.reply_parameters) {
        try {
          const { reply_parameters: _rp, ...rest } = extra;
          await bot.api.raw.sendMessage({
            chat_id: replyChatId,
            text: phrase,
            ...rest,
          });
          return { ok: true, phrase };
        } catch (err2) {
          console.warn(
            "phrase via replyChatId (no reply) failed",
            err2?.message || err2,
          );
        }
      }
    }
  }
  if (fromUserId) {
    try {
      await bot.api.sendMessage(fromUserId, phrase);
      return { ok: true, phrase };
    } catch (err) {
      console.warn("phrase via fromUserId failed", err?.message || err);
      return { ok: false, phrase, error: err?.message || String(err) };
    }
  }
  return {
    ok: false,
    phrase,
    error: "no replyChatId/fromUserId or channel DM topic missing",
  };
}

/**
 * Next free members day (no admin that day, < 4 members already).
 * @param {string} fromDay
 * @param {string} tz
 */
async function findNextMembersDay(fromDay, tz) {
  let day = fromDay;
  for (let i = 0; i < 60; i++) {
    const slots = await membersSlotsLeftOnDay(day, tz);
    if (slots > 0) return day;
    day = addDays(day, 1);
  }
  return day;
}

/**
 * After ingest: ALWAYS schedule (never post to channel here) + phrase-reply to author.
 * @param {import('./store.js').MemberItem} item
 * @param {import('grammy').Bot} bot
 * @param {{
 *   replyChatId?: string|number,
 *   replyToMessageId?: number,
 *   directMessagesTopicId?: number,
 *   messageThreadId?: number,
 * }} [opts]
 */
export async function placeMemberItem(item, bot, opts = {}) {
  const tz = config.timeZone;
  const channelId = config.groupChatId;
  if (!channelId) throw new Error("GROUP_CHAT_ID missing");
  const replyChatId = opts.replyChatId;
  const replyToMessageId = opts.replyToMessageId;
  const directMessagesTopicId = opts.directMessagesTopicId;
  const messageThreadId = opts.messageThreadId;

  const today = localDayString(tz);
  const { hour } = wallClock(tz);

  // Never publish to channel on ingest — only members queue + cron/tick posts later.
  // Admin already used today → start looking from tomorrow.
  let day = today;
  const adminToday = await adminPostedOnDay(today, tz);
  const slotsToday = await membersSlotsLeftOnDay(today, tz);
  if (adminToday || slotsToday <= 0 || hour >= 22) {
    day = addDays(today, 1);
  }
  day = await findNextMembersDay(day, tz);

  /** @type {Date} */
  let postAt;
  if (day === today && hour < 22) {
    // later today, still inside 10–22 window
    if (hour < 10) {
      postAt = randomPostAt(day, tz);
    } else {
      const start = new Date(Date.now() + 5 * 60 * 1000);
      const end = localDateTime(day, 22, 0, tz);
      if (start >= end) {
        day = await findNextMembersDay(addDays(today, 1), tz);
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

  try {
    const adminId = assertAdminId();
    const why = adminToday
      ? "admin already posted today → members deferred"
      : slotsToday <= 0
        ? "no members slots today"
        : hour >= 22
          ? "after 22:00 window"
          : "queued";
    await bot.api.sendMessage(
      adminId,
      `👥 Members queue +1\n` +
        (item.fromUsername ? `@${item.fromUsername}\n` : "") +
        `${why}\n` +
        `when: ${formatLocal(postAt, tz)}\n` +
        `day: ${day}\n` +
        `id: <code>${item.id}</code>`,
      { parse_mode: "HTML" },
    );
  } catch {
    /* ignore */
  }

  // Always auto-reply author with a film phrase in channel DMs / monoforum
  const notified = await replyAuthorWithPhrase(bot, {
    replyChatId,
    fromUserId: item.fromUserId,
    replyToMessageId,
    directMessagesTopicId,
    messageThreadId,
  });
  if (!notified.ok) {
    console.warn(
      "author phrase not delivered",
      item.id,
      notified.error || "",
      "topic=",
      directMessagesTopicId,
    );
  }
  await updateMemberItem(item.id, { authorNotified: notified.ok });

  return {
    mode: "scheduled",
    postAt,
    messageId: null,
    postDay: day,
    phrase: notified.phrase,
    authorNotified: notified.ok,
    deferredForAdmin: adminToday,
  };
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
    // safety: don't post members on admin day (day-state + admin queue)
    if (await adminPostedOnDay(day, tz)) {
      const nextDay = await findNextMembersDay(addDays(day, 1), tz);
      const postAt = randomPostAt(nextDay, tz);
      await updateMemberItem(item.id, {
        postDay: nextDay,
        postAt: postAt.toISOString(),
      });
      summary.actions.push(`defer_admin_day:${item.id}->${nextDay}`);
      continue;
    }
    const slotsLeft = await membersSlotsLeftOnDay(day, tz);
    if (slotsLeft <= 0) {
      const nextDay = await findNextMembersDay(addDays(day, 1), tz);
      const postAt = randomPostAt(nextDay, tz);
      await updateMemberItem(item.id, {
        postDay: nextDay,
        postAt: postAt.toISOString(),
      });
      summary.actions.push(`defer_full:${item.id}->${nextDay}`);
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
  // force post even if limits — admin "Post now" from members browser
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
