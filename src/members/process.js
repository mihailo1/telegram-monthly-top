/**
 * Members queue scheduling & posting.
 *
 * Rules (from product):
 * - Prefer immediate forward (repost) to the channel
 * - If any channel post in the last hour → schedule now+1h (chain +1h between items)
 * - Album = one queue item / one forward
 * - Author: film phrase on immediate; ETA text when deferred
 * - Priority over admin queue (admin defers on recent members pulse)
 */
import { Bot } from "grammy";
import { assertAdminId, assertBotToken, config } from "../config.js";
import { incrementDayPost } from "../scheduler/dayState.js";
import {
  loadChannelPulse,
  markChannelPosted,
  nextAllowedAt,
  PULSE_GAP_MS,
} from "../scheduler/channelPulse.js";
import { formatLocal, localDayString } from "../queue/time.js";
import {
  countMembersActive,
  getMemberItem,
  getMembersScheduled,
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

/**
 * Prefer true forward (repost) from channel DMs; fall back to copy-send.
 * @param {import('grammy').Api} api
 * @param {string|number} chatId  destination channel
 * @param {import('./store.js').MemberItem} item
 */
export async function publishMemberItem(api, chatId, item) {
  const sourceChatId = item.sourceChatId;
  const sourceIds = (item.sourceMessageIds || [])
    .map(Number)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);

  if (sourceChatId && sourceIds.length) {
    try {
      // grammY: forwardMessages(chat_id, from_chat_id, message_ids)
      if (sourceIds.length > 1 && typeof api.forwardMessages === "function") {
        const ids = await api.forwardMessages(
          chatId,
          sourceChatId,
          sourceIds,
        );
        const mid = Array.isArray(ids) ? ids[0]?.message_id : undefined;
        return { message_id: mid ?? sourceIds[0] };
      }
      return await api.forwardMessage(chatId, sourceChatId, sourceIds[0]);
    } catch (err) {
      console.warn(
        "forward to channel failed, falling back to copy-send",
        err?.message || err,
      );
    }
  }

  // Fallback: re-send by file_id (GramJS ingest / forward unavailable)
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
  const media = memberItemToInputMedia(item, true);
  const msgs = await api.sendMediaGroup(chatId, media);
  return msgs[0];
}

/**
 * Next free post time: max(now, lastChannelPost+1h, latest scheduled members+1h).
 * @returns {Promise<Date>}
 */
export async function computeMembersPostAt(nowMs = Date.now()) {
  const pulse = await loadChannelPulse();
  let at = nextAllowedAt(pulse, nowMs).getTime();

  const { items } = await loadMembersQueue();
  for (const x of items) {
    if (x.status !== "scheduled" || !x.postAt) continue;
    const t = new Date(x.postAt).getTime();
    if (Number.isFinite(t)) {
      at = Math.max(at, t + PULSE_GAP_MS);
    }
  }
  return new Date(at);
}

/** HH:MM in APP_TZ */
export function formatEtaClock(when, timeZone = config.timeZone) {
  const d = typeof when === "string" ? new Date(when) : when;
  return d.toLocaleString("ru-RU", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
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
 *   text?: string,
 *   caption?: string,
 * }} opts
 * @returns {Promise<{ ok: boolean, phrase: string, error?: string }>}
 */
export async function replyAuthorWithPhrase(bot, opts = {}) {
  const { pickReplyPhrase } = await import("../phraseEmbed.js");
  const userText = (opts.text || opts.caption || "").trim();
  const phrase = await pickReplyPhrase(userText);
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
 * Send arbitrary text to author in channel DM / monoforum (topic-aware).
 * @param {import('grammy').Bot} bot
 * @param {string} text
 * @param {{
 *   replyChatId?: string|number,
 *   fromUserId?: string|number,
 *   replyToMessageId?: number,
 *   directMessagesTopicId?: number,
 *   messageThreadId?: number,
 * }} opts
 */
export async function replyAuthorText(bot, text, opts = {}) {
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
  if (directMessagesTopicId != null) {
    extra.direct_messages_topic_id = directMessagesTopicId;
  }
  if (messageThreadId != null) {
    extra.message_thread_id = messageThreadId;
  } else if (directMessagesTopicId != null) {
    extra.message_thread_id = directMessagesTopicId;
  }

  if (replyChatId) {
    try {
      await bot.api.raw.sendMessage({
        chat_id: replyChatId,
        text,
        ...extra,
      });
      return { ok: true, text };
    } catch (err) {
      console.warn("replyAuthorText chat failed", err?.message || err);
      if (extra.reply_parameters) {
        try {
          const { reply_parameters: _rp, ...rest } = extra;
          await bot.api.raw.sendMessage({
            chat_id: replyChatId,
            text,
            ...rest,
          });
          return { ok: true, text };
        } catch (err2) {
          console.warn("replyAuthorText retry failed", err2?.message || err2);
        }
      }
    }
  }
  if (fromUserId) {
    try {
      await bot.api.sendMessage(fromUserId, text);
      return { ok: true, text };
    } catch (err) {
      return { ok: false, text, error: err?.message || String(err) };
    }
  }
  return { ok: false, text, error: "no reply target" };
}

/**
 * Place member item: immediate forward if pulse allows, else schedule +1h chain.
 * @param {import('./store.js').MemberItem} item
 * @param {import('grammy').Bot} bot
 * @param {{
 *   replyChatId?: string|number,
 *   replyToMessageId?: number,
 *   directMessagesTopicId?: number,
 *   messageThreadId?: number,
 *   skipAuthorReply?: boolean,
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

  const now = Date.now();
  const postAt = await computeMembersPostAt(now);
  const immediate = postAt.getTime() <= now + 2000; // 2s slack
  const today = localDayString(tz);

  if (immediate) {
    try {
      const msg = await publishMemberItem(bot.api, channelId, item);
      await updateMemberItem(item.id, {
        status: "posted",
        postedAt: new Date().toISOString(),
        postedMessageId: msg?.message_id,
        postDay: today,
        postAt: null,
      });
      await markChannelPosted("members", item.id);
      try {
        await incrementDayPost("members", today);
      } catch {
        /* ignore */
      }

      let authorNotified = false;
      let phrase = "";
      if (!opts.skipAuthorReply) {
        const notified = await replyAuthorWithPhrase(bot, {
          replyChatId,
          fromUserId: item.fromUserId,
          replyToMessageId,
          directMessagesTopicId,
          messageThreadId,
        });
        authorNotified = notified.ok;
        phrase = notified.phrase;
        await updateMemberItem(item.id, { authorNotified });
      }

      try {
        await bot.api.sendMessage(
          assertAdminId(),
          `👥 Members: forwarded to channel\nid: <code>${item.id}</code>`,
          { parse_mode: "HTML" },
        );
      } catch {
        /* ignore */
      }

      return {
        mode: "immediate",
        postAt: null,
        messageId: msg?.message_id ?? null,
        postDay: today,
        phrase,
        authorNotified,
      };
    } catch (err) {
      console.error("members immediate forward failed, scheduling", err);
      // fall through to schedule
    }
  }

  const when = immediate ? new Date(now + PULSE_GAP_MS) : postAt;
  const day = localDayString(tz, when);
  await updateMemberItem(item.id, {
    status: "scheduled",
    postDay: day,
    postAt: when.toISOString(),
  });

  const eta = formatEtaClock(when, tz);
  const etaText = `Уже был пост недавно, запостим в ${eta}`;

  try {
    await bot.api.sendMessage(
      assertAdminId(),
      `👥 Members queue +1 (wait)\n` +
        (item.fromUsername ? `@${item.fromUsername}\n` : "") +
        `when: ${formatLocal(when, tz)}\n` +
        `id: <code>${item.id}</code>`,
      { parse_mode: "HTML" },
    );
  } catch {
    /* ignore */
  }

  let authorNotified = false;
  if (!opts.skipAuthorReply) {
    const notified = await replyAuthorText(bot, etaText, {
      replyChatId,
      fromUserId: item.fromUserId,
      replyToMessageId,
      directMessagesTopicId,
      messageThreadId,
    });
    authorNotified = notified.ok;
    await updateMemberItem(item.id, { authorNotified });
  }

  return {
    mode: "scheduled",
    postAt: when,
    messageId: null,
    postDay: day,
    phrase: etaText,
    authorNotified,
  };
}

/**
 * Tick: post due members items (1h pulse; no day-slot gates).
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
    // Respect 1h pulse vs whatever just posted
    const pulse = await loadChannelPulse();
    const allowed = nextAllowedAt(pulse).getTime();
    if (allowed > Date.now() + 2000) {
      await updateMemberItem(item.id, {
        postAt: new Date(allowed).toISOString(),
        postDay: localDayString(tz, new Date(allowed)),
      });
      summary.actions.push(`defer_pulse:${item.id}`);
      continue;
    }

    try {
      const msg = await publishMemberItem(bot.api, channelId, item);
      const day = localDayString(tz);
      await updateMemberItem(item.id, {
        status: "posted",
        postedAt: new Date().toISOString(),
        postedMessageId: msg?.message_id,
        postDay: day,
      });
      await markChannelPosted("members", item.id);
      try {
        await incrementDayPost("members", day);
      } catch {
        /* ignore */
      }
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
  // force post — admin "Post now" from members browser
  try {
    const msg = await publishMemberItem(bot.api, channelId, item);
    await updateMemberItem(id, {
      status: "posted",
      postedAt: new Date().toISOString(),
      postedMessageId: msg?.message_id,
      postDay: today,
    });
    await markChannelPosted("members", id);
    try {
      await incrementDayPost("members", today);
    } catch {
      /* ignore */
    }
    return { ok: true, messageId: msg?.message_id };
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
    "Source: channel Direct Messages (forward/repost).",
    "Immediate if free · else +1h spacing · priority over admin.",
  );
  return lines.filter(Boolean).join("\n");
}
