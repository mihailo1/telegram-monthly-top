/**
 * grammY bot: monthly preview + daily photo queue browser.
 *
 * Keyboard: Preview | Queue | Help
 * Photos → queue (album → one “Uploaded N” ack)
 * Queue → browse with ◀️▶️, post now, delete
 */
import { Bot, InlineKeyboard, Keyboard } from "grammy";
import { assertBotToken, config } from "./config.js";
import { loadPending, updatePending } from "./pending.js";
import { publishAlbumAndPoll } from "./publish.js";
import {
  clearAlbumBatch,
  recordAlbumPart,
  runInBackground,
  sleep,
  tryClaimAlbumFinalize,
} from "./queue/albumBatch.js";
import {
  cancelQueueItem,
  postScheduledNow,
  processQueueTick,
  queueStatusText,
} from "./queue/process.js";
import {
  appendMedia,
  countActive,
  itemMediaType,
  listActiveInOrder,
  loadQueue,
} from "./queue/store.js";
import { formatLocal } from "./queue/time.js";
import {
  cancelMemberItem,
  membersQueueStatusText,
  postMemberNow,
} from "./members/process.js";
import {
  getMemberItem,
  listMembersActive,
  loadMembersQueue,
} from "./members/store.js";

export const BTN = {
  preview: "📊 Preview",
  queue: "📋 Queue",
  members: "👥 Members queue",
  help: "ℹ️ Help",
};

export function mainKeyboard() {
  return new Keyboard()
    .text(BTN.preview)
    .text(BTN.queue)
    .row()
    .text(BTN.members)
    .text(BTN.help)
    .resized()
    .persistent();
}

const BOT_COMMANDS = [
  { command: "start", description: "Menu" },
  { command: "preview", description: "Monthly top preview" },
  { command: "queue", description: "Admin media queue" },
  { command: "members", description: "Members (UGC) queue" },
  { command: "help", description: "Help" },
];

export async function setupBotMenu(bot) {
  await bot.api.setMyCommands(BOT_COMMANDS);
}

/**
 * @param {import('grammy').Context['message']} msg
 * @returns {{ fileId: string, mediaType: "photo"|"video" } | null}
 */
function extractQueueMedia(msg) {
  if (!msg) return null;
  if (msg.photo?.length) {
    return {
      fileId: msg.photo[msg.photo.length - 1].file_id,
      mediaType: "photo",
    };
  }
  if (msg.video?.file_id) {
    return { fileId: msg.video.file_id, mediaType: "video" };
  }
  // video note / animation optional later
  if (msg.animation?.file_id) {
    // treat gif as video for channel sendVideo may fail — use document path skip
    return null;
  }
  return null;
}

/**
 * @param {import('./queue/store.js').QueueItem} item
 * @param {number} index
 * @param {number} total
 */
function queueItemCaption(item, index, total) {
  const kind = itemMediaType(item) === "video" ? "🎬 video" : "🖼 photo";
  const lines = [
    `📋 <b>Admin queue</b> · ${index + 1}/${total}`,
    `type: ${kind}`,
    `status: <b>${item.status}</b>`,
  ];
  if (item.postAt) {
    lines.push(`when: ${formatLocal(item.postAt, config.timeZone)}`);
  }
  if (item.status === "scheduled") {
    lines.push("↑ next to publish");
  }
  lines.push(`id: <code>${item.id}</code>`);
  return lines.join("\n");
}

/**
 * @param {number} index
 * @param {number} total
 * @param {string} id
 */
function queueBrowserKeyboard(index, total, id) {
  const prev = total <= 1 ? index : (index - 1 + total) % total;
  const next = total <= 1 ? index : (index + 1) % total;
  return new InlineKeyboard()
    .text("◀️", `qnav:${prev}`)
    .text(`${index + 1}/${total}`, "qnav:noop")
    .text("▶️", `qnav:${next}`)
    .row()
    .text("✅ Post now", `qpostnow:${id}`)
    .text("🗑 Delete", `qdel:${id}`);
}

/**
 * @returns {Bot}
 */
export function createBot() {
  const bot = new Bot(assertBotToken());

  function isAdmin(ctx) {
    if (!config.adminId) return true;
    return String(ctx.from?.id) === String(config.adminId);
  }

  function requireAdminPrivate(ctx) {
    if (ctx.chat?.type !== "private") return "Use a private chat with the bot.";
    if (!isAdmin(ctx)) return "Access denied (not ADMIN_ID).";
    return null;
  }

  async function sendWelcome(ctx) {
    if (ctx.chat?.type === "private" && !isAdmin(ctx)) {
      await ctx.reply("Access denied (not ADMIN_ID).");
      return;
    }
    const state = await loadQueue();
    const active = countActive(state);
    await ctx.reply(
      [
        "<b>monthly-top + daily queue</b>",
        "",
        `channel: @${config.channelUsername}`,
        `in queue: <b>${active}</b>`,
        "",
        "📊 Preview — monthly top",
        "📋 Queue — your admin queue",
        "👥 Members queue — channel Direct Messages",
        "ℹ️ Help",
        "",
        "📷 To this bot (you): admin queue.",
        "Channel DMs: members queue (priority).",
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: mainKeyboard() },
    );
  }

  async function sendHelp(ctx) {
    await ctx.reply(
      [
        "<b>Help</b>",
        "",
        "<b>Monthly top</b> — 📊 Preview → ✅/❌ to channel",
        "",
        "<b>Daily media</b>",
        "• Photos and <b>videos</b> in queue (mixed albums OK)",
        "• Album → one “📷 Uploaded N” summary",
        "• 📋 Queue — ◀️▶️, ✅ post now, 🗑 delete",
        "• 1 media/day · 10:00–22:00 MSK · next-day notify",
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: mainKeyboard() },
    );
  }

  async function runPreviewFromChat(ctx) {
    const deny = requireAdminPrivate(ctx);
    if (deny) {
      await ctx.reply(deny);
      return;
    }

    await ctx.reply("⏳ Collecting last month’s top…", {
      reply_markup: mainKeyboard(),
    });

    try {
      if (config.isVercel && config.publicUrl && config.cronSecret) {
        const url = `${config.publicUrl}/api/preview?secret=${encodeURIComponent(config.cronSecret)}`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(55_000),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.ok === false) {
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        await ctx.reply(
          `✅ Preview ready.\ntop: <b>${body.topCount}</b> · ${body.rangeLabel || ""}`,
          { parse_mode: "HTML", reply_markup: mainKeyboard() },
        );
        return;
      }

      const { runMonthlyPreview } = await import("./runPreview.js");
      const result = await runMonthlyPreview({ interactive: false });
      await ctx.reply(
        `✅ Preview ready.\ntop: <b>${result.topCount}</b> · ${result.rangeLabel}`,
        { parse_mode: "HTML", reply_markup: mainKeyboard() },
      );
    } catch (err) {
      console.error("preview failed", err);
      await ctx.reply(
        `⚠️ Preview failed:\n<code>${escapeHtml(err.message || String(err))}</code>`,
        { parse_mode: "HTML", reply_markup: mainKeyboard() },
      );
    }
  }

  /**
   * Open / refresh queue browser at index.
   * @param {import('grammy').Context} ctx
   * @param {number} index
   * @param {"send"|"edit"} mode
   */
  async function showQueueBrowser(ctx, index = 0, mode = "send") {
    const state = await loadQueue();
    const active = listActiveInOrder(state);

    if (active.length === 0) {
      const text = await queueStatusText();
      if (mode === "edit" && ctx.callbackQuery) {
        try {
          await ctx.editMessageCaption({
            caption: "📋 Queue is empty.",
            parse_mode: "HTML",
          });
        } catch {
          await ctx.reply(text, {
            parse_mode: "HTML",
            reply_markup: mainKeyboard(),
          });
        }
      } else {
        await ctx.reply(text, {
          parse_mode: "HTML",
          reply_markup: mainKeyboard(),
        });
      }
      return;
    }

    let i = index;
    if (i < 0) i = active.length - 1;
    if (i >= active.length) i = 0;
    const item = active[i];
    const caption = queueItemCaption(item, i, active.length);
    const keyboard = queueBrowserKeyboard(i, active.length, item.id);

    const kind = itemMediaType(item);
    if (mode === "edit" && ctx.callbackQuery) {
      try {
        await ctx.editMessageMedia(
          {
            type: kind === "video" ? "video" : "photo",
            media: item.fileId,
            caption,
            parse_mode: "HTML",
          },
          { reply_markup: keyboard },
        );
        return;
      } catch (err) {
        console.warn("editMessageMedia failed, resend", err.message);
      }
    }

    if (kind === "video") {
      await ctx.replyWithVideo(item.fileId, {
        caption,
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } else {
      await ctx.replyWithPhoto(item.fileId, {
        caption,
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    }
  }

  async function finalizeAlbumAck(chatId, groupId) {
    // Quiet period so all parallel media-group updates land as parts
    await sleep(3000);
    let claimed = await tryClaimAlbumFinalize(chatId, groupId, 2500);
    if (!claimed) {
      await sleep(3000);
      claimed = await tryClaimAlbumFinalize(chatId, groupId, 2000);
    }
    if (!claimed) return;
    return finishAlbumAck(chatId, groupId, claimed);
  }

  async function finishAlbumAck(chatId, groupId, claimed) {
    const state = await loadQueue();
    const total = countActive(state);
    try {
      await bot.api.sendMessage(
        chatId,
        [
          `📷 <b>Uploaded ${claimed.count}</b> file(s) to the queue.`,
          `Total in queue: <b>${total}</b>`,
          "",
          "Upload complete ✅",
        ].join("\n"),
        { parse_mode: "HTML", reply_markup: mainKeyboard() },
      );
    } catch (err) {
      console.error("album ack failed", err);
    }
    try {
      // Only schedules/notifies if needed (no duplicate notify when already sent)
      await processQueueTick({ bot });
    } catch (err) {
      console.warn("tick after album:", err.message);
    }
    await clearAlbumBatch(chatId, groupId);
  }

  // --- Commands ---
  bot.command("start", sendWelcome);
  bot.command("menu", sendWelcome);
  bot.command("help", sendHelp);
  bot.command("preview", runPreviewFromChat);

  bot.command("queue", async (ctx) => {
    const deny = requireAdminPrivate(ctx);
    if (deny) {
      await ctx.reply(deny);
      return;
    }
    await showQueueBrowser(ctx, 0, "send");
  });

  /**
   * Members queue browser — full album preview (all photos/videos) + controls.
   * Multi-media: sendMediaGroup + control message (Telegram can't put buttons on albums).
   */
  /**
   * @param {import('grammy').Context} ctx
   * @param {number} index
   * @param {{ excludeId?: string }} [opts]
   */
  async function showMembersBrowser(ctx, index = 0, opts = {}) {
    const adminId = ctx.chat?.id || config.adminId;
    const { items } = await loadMembersQueue();
    let active = listMembersActive(items);
    // Belt-and-suspenders after delete (blob list may lag)
    if (opts.excludeId) {
      active = active.filter((it) => it.id !== opts.excludeId);
    }

    const {
      clearBrowserPreview,
      saveBrowserSession,
    } = await import("./members/browserSession.js");
    const { memberItemToInputMedia } = await import("./members/process.js");

    // Remove previous preview album + controls (incl. the message user clicked)
    const extraIds = [];
    if (ctx.callbackQuery?.message?.message_id) {
      extraIds.push(ctx.callbackQuery.message.message_id);
    }
    try {
      await clearBrowserPreview(bot.api, adminId, adminId, extraIds);
    } catch {
      /* ignore */
    }

    if (active.length === 0) {
      await ctx.reply(await membersQueueStatusText(), {
        parse_mode: "HTML",
        reply_markup: mainKeyboard(),
      });
      return;
    }

    let i = Number.isFinite(index) ? index : 0;
    if (i < 0) i = 0;
    if (i >= active.length) i = active.length - 1;
    const item = active[i];
    const who = item.fromUsername
      ? `@${item.fromUsername}`
      : item.fromUserId || "—";
    const mediaCount = item.media?.length || 0;
    const types = (item.media || [])
      .map((m) => (m.mediaType === "video" ? "🎬" : "🖼"))
      .join("");
    const controlText = [
      `👥 <b>Members</b> · ${i + 1}/${active.length}`,
      `from: ${who}`,
      `status: <b>${item.status}</b>`,
      item.postAt
        ? `when: ${formatLocal(item.postAt, config.timeZone)}`
        : "",
      `media: <b>${mediaCount}</b> ${types}`,
      item.caption
        ? `caption: ${escapeHtml(item.caption.slice(0, 300))}`
        : "caption: —",
      `id: <code>${item.id}</code>`,
      mediaCount > 1 ? "\n↑ album above (all media in this post)" : "",
    ]
      .filter(Boolean)
      .join("\n");

    const prev = active.length <= 1 ? i : (i - 1 + active.length) % active.length;
    const next = active.length <= 1 ? i : (i + 1) % active.length;
    const keyboard = new InlineKeyboard()
      .text("◀️", `mnav:${prev}`)
      .text(`${i + 1}/${active.length}`, "mnav:noop")
      .text("▶️", `mnav:${next}`)
      .row()
      .text("✅ Post now", `mpostnow:${item.id}`)
      .text("🗑 Delete", `mdel:${item.id}`);

    /** @type {number[]} */
    let albumMessageIds = [];

    if (mediaCount === 0) {
      const ctrl = await ctx.reply("⚠️ This post has no media.\n" + controlText, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      await saveBrowserSession(adminId, {
        albumMessageIds: [],
        controlMessageId: ctrl.message_id,
        index: i,
      });
      return;
    }

    if (mediaCount === 1) {
      const m = item.media[0];
      const sent =
        m.mediaType === "video"
          ? await ctx.replyWithVideo(m.fileId, {
              caption: controlText,
              parse_mode: "HTML",
              reply_markup: keyboard,
            })
          : await ctx.replyWithPhoto(m.fileId, {
              caption: controlText,
              parse_mode: "HTML",
              reply_markup: keyboard,
            });
      albumMessageIds = [sent.message_id];
      await saveBrowserSession(adminId, {
        albumMessageIds,
        controlMessageId: sent.message_id,
        index: i,
      });
      return;
    }

    // 2–10: full album, then controls under it
    const inputMedia = memberItemToInputMedia(
      {
        ...item,
        // put meta caption on first only if no user caption — else user caption on album
        caption: item.caption || undefined,
      },
      true,
    );
    // If no user caption, put short header on first media
    if (!item.caption) {
      inputMedia[0].caption = `👥 ${i + 1}/${active.length} · ${mediaCount} file(s)`;
    }

    const albumMsgs = await ctx.api.sendMediaGroup(adminId, inputMedia);
    albumMessageIds = albumMsgs.map((m) => m.message_id);

    const ctrl = await ctx.reply(controlText, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });

    await saveBrowserSession(adminId, {
      albumMessageIds,
      controlMessageId: ctrl.message_id,
      index: i,
    });
  }

  bot.command("members", async (ctx) => {
    const deny = requireAdminPrivate(ctx);
    if (deny) {
      await ctx.reply(deny);
      return;
    }
    await showMembersBrowser(ctx, 0, "send");
  });

  bot.hears(BTN.preview, runPreviewFromChat);
  bot.hears(BTN.queue, async (ctx) => {
    const deny = requireAdminPrivate(ctx);
    if (deny) {
      await ctx.reply(deny);
      return;
    }
    await showQueueBrowser(ctx, 0, "send");
  });
  bot.hears(BTN.members, async (ctx) => {
    const deny = requireAdminPrivate(ctx);
    if (deny) {
      await ctx.reply(deny);
      return;
    }
    await showMembersBrowser(ctx, 0, "send");
  });
  bot.hears(BTN.help, sendHelp);

  // --- Incoming photo / video ---
  // Admin in bot DM → admin queue
  // Anyone else (channel Direct Messages, monoforum, users) → members queue
  // Never reject non-admin media with a private-chat error (channel DMs use members queue).

  async function enqueueAdminMedia(ctx, media) {
    try {
      const { totalQueued } = await appendMedia([media]);
      const groupId = ctx.message.media_group_id;

      if (groupId) {
        await recordAlbumPart(ctx.chat.id, groupId);
        const chatId = ctx.chat.id;
        runInBackground(() => finalizeAlbumAck(chatId, groupId));
        return;
      }

      const label = media.mediaType === "video" ? "video" : "photo";
      await ctx.reply(
        [
          `📷 +1 ${label} to the <b>admin</b> queue.`,
          `Total in queue: <b>${totalQueued}</b>`,
          "",
          "Upload complete ✅",
        ].join("\n"),
        { parse_mode: "HTML", reply_markup: mainKeyboard() },
      );
      try {
        await processQueueTick({ bot });
      } catch (err) {
        console.warn("tick after enqueue:", err.message);
      }
    } catch (err) {
      console.error("admin enqueue failed", err);
      await ctx.reply(`⚠️ Queue error: ${err.message ?? err}`);
    }
  }

  async function enqueueMemberMedia(ctx, media) {
    const {
      appendMemberPost,
    } = await import("./members/store.js");
    const {
      placeMemberItem,
      extractDirectMessagesTopicId,
    } = await import("./members/process.js");
    const {
      recordMemberAlbumPart,
      scheduleMemberAlbumFinalize,
    } = await import("./members/albumIngest.js");

    const fromUserId = String(ctx.from?.id || "");
    const fromUsername = ctx.from?.username || "";
    const caption = ctx.message.caption || "";
    const groupId = ctx.message.media_group_id;
    const chatId = ctx.chat.id;
    // Channel Direct Messages: each user conversation is a topic (required to reply)
    const dmTopicId = extractDirectMessagesTopicId(ctx.message);
    const threadId =
      ctx.message.message_thread_id ?? ctx.message.messageThreadId;

    try {
      if (groupId) {
        await recordMemberAlbumPart(chatId, groupId, {
          fileId: media.fileId,
          mediaType: media.mediaType,
          caption,
          fromUserId,
          fromUsername,
          messageId: ctx.message.message_id,
          directMessagesTopicId: dmTopicId,
          messageThreadId: threadId,
        });
        scheduleMemberAlbumFinalize(chatId, groupId, async (parts) => {
          const mediaList = parts.map((p) => ({
            fileId: p.fileId,
            mediaType: p.mediaType === "video" ? "video" : "photo",
          }));
          const cap =
            parts.map((p) => p.caption).find((c) => c && c.trim()) || "";
          const firstMsgId = parts
            .map((p) => p.messageId)
            .find((id) => id && id > 0);
          const topicFromParts = parts
            .map((p) => p.directMessagesTopicId)
            .find((id) => id != null);
          const threadFromParts = parts
            .map((p) => p.messageThreadId)
            .find((id) => id != null);
          const item = await appendMemberPost({
            media: mediaList,
            caption: cap,
            fromUserId: parts[0]?.fromUserId || fromUserId,
            fromUsername: parts[0]?.fromUsername || fromUsername,
            sourceKey: `bot_album_${chatId}_${groupId}`,
          });
          // placeMemberItem: enqueue only (never channel) + film phrase to author
          await placeMemberItem(item, bot, {
            replyChatId: chatId,
            replyToMessageId: firstMsgId || undefined,
            directMessagesTopicId: topicFromParts ?? dmTopicId,
            messageThreadId: threadFromParts ?? threadId,
          });
        });
        return;
      }

      const item = await appendMemberPost({
        media: [media],
        caption,
        fromUserId,
        fromUsername,
        sourceKey: `bot_${chatId}_${ctx.message.message_id}`,
      });
      // Always: members queue + one film phrase in channel DMs (never channel post here)
      await placeMemberItem(item, bot, {
        replyChatId: chatId,
        replyToMessageId: ctx.message.message_id,
        directMessagesTopicId: dmTopicId,
        messageThreadId: threadId,
      });
    } catch (err) {
      console.error("member enqueue failed", err);
      // Don't spam channel-DM authors with errors; log for admin
      try {
        if (isAdmin(ctx) && ctx.chat?.type === "private") {
          await ctx.reply(`⚠️ Members enqueue: ${err.message ?? err}`);
        }
      } catch {
        /* ignore */
      }
    }
  }

  async function enqueueFromMessage(ctx) {
    const media = extractQueueMedia(ctx.message);
    // Pure text / stickers etc. — ignore silently (product rule)
    if (!media) return;

    // Admin managing their own queue: only in private chat with bot
    if (ctx.chat?.type === "private" && isAdmin(ctx)) {
      await enqueueAdminMedia(ctx, media);
      return;
    }

    // Channel Direct Messages / monoforum / any non-admin media → members queue
    await enqueueMemberMedia(ctx, media);
  }

  bot.on("message:photo", enqueueFromMessage);
  bot.on("message:video", enqueueFromMessage);

  // Any other message in channel DM / monoforum (text etc.): random phrase only
  bot.on("message:text", async (ctx) => {
    // Admin private: ignore (commands/keyboard handled elsewhere)
    if (ctx.chat?.type === "private" && isAdmin(ctx)) return;
    // Skip commands
    if (ctx.message.text?.startsWith("/")) return;

    try {
      const {
        replyAuthorWithPhrase,
        extractDirectMessagesTopicId,
      } = await import("./members/process.js");
      await replyAuthorWithPhrase(bot, {
        replyChatId: ctx.chat.id,
        fromUserId: ctx.from?.id,
        replyToMessageId: ctx.message.message_id,
        directMessagesTopicId: extractDirectMessagesTopicId(ctx.message),
        messageThreadId:
          ctx.message.message_thread_id ?? ctx.message.messageThreadId,
      });
    } catch (err) {
      console.warn("phrase reply failed", err.message);
    }
  });

  // --- Callbacks ---
  bot.on("callback_query:data", async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCallbackQuery({ text: "Access denied", show_alert: true });
      return;
    }

    const data = ctx.callbackQuery.data || "";

    // Members browser nav
    if (data.startsWith("mnav:")) {
      const raw = data.slice("mnav:".length);
      if (raw === "noop") {
        await ctx.answerCallbackQuery();
        return;
      }
      const index = Number(raw);
      await ctx.answerCallbackQuery();
      await showMembersBrowser(ctx, index);
      return;
    }

    if (data.startsWith("mdel:")) {
      const id = data.slice("mdel:".length);
      let nextIdx = 0;
      try {
        const { loadBrowserSession } = await import(
          "./members/browserSession.js"
        );
        const sess = await loadBrowserSession(ctx.chat.id);
        nextIdx = sess?.index ?? 0;
      } catch {
        /* ignore */
      }

      const result = await cancelMemberItem(id);
      if (!result.ok) {
        await ctx.answerCallbackQuery({
          text: result.error || "error",
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery({ text: "Deleted" });

      // Fresh list without deleted item; keep position (or last)
      await showMembersBrowser(ctx, nextIdx, { excludeId: id });
      return;
    }

    if (data.startsWith("mpostnow:")) {
      const id = data.slice("mpostnow:".length);
      const result = await postMemberNow(id, bot);
      if (!result.ok) {
        await ctx.answerCallbackQuery({
          text: result.error || "error",
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery({ text: "Published" });
      const link = config.channelUsername
        ? `https://t.me/${config.channelUsername}/${result.messageId}`
        : "";
      await ctx.reply(
        `✅ Members post to channel` +
          (link ? `: <a href="${link}">open</a>` : ""),
        {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: mainKeyboard(),
        },
      );
      // Also remove from store view if postMemberNow only marks posted — hard-remove optional
      await showMembersBrowser(ctx, 0, { excludeId: id });
      return;
    }

    // Admin queue browser navigation
    if (data.startsWith("qnav:")) {
      const raw = data.slice("qnav:".length);
      if (raw === "noop") {
        await ctx.answerCallbackQuery();
        return;
      }
      const index = Number(raw);
      if (!Number.isFinite(index)) {
        await ctx.answerCallbackQuery({ text: "bad index" });
        return;
      }
      await ctx.answerCallbackQuery();
      await showQueueBrowser(ctx, index, "edit");
      return;
    }

    // Delete from queue (no channel post)
    if (data.startsWith("qdel:")) {
      const id = data.slice("qdel:".length);
      const result = await cancelQueueItem(id, bot);
      if (!result.ok) {
        await ctx.answerCallbackQuery({
          text: result.error || "error",
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery({ text: "Deleted" });

      // Stay in browser at same index
      const state = await loadQueue();
      const active = listActiveInOrder(state);
      if (active.length === 0) {
        try {
          await ctx.editMessageCaption({
            caption: "📋 Queue is empty.",
            parse_mode: "HTML",
          });
        } catch {
          await ctx.reply("📋 Queue is empty.", {
            reply_markup: mainKeyboard(),
          });
        }
        return;
      }
      // After delete, show photo that slid into this position (or last)
      const captionMatch = ctx.callbackQuery.message?.caption || "";
      const m = captionMatch.match(/·\s*(\d+)\//);
      let idx = m ? Number(m[1]) - 1 : 0;
      if (idx >= active.length) idx = active.length - 1;
      if (idx < 0) idx = 0;
      await showQueueBrowser(ctx, idx, "edit");
      return;
    }

    // Daily queue: post now
    if (data.startsWith("qpostnow:")) {
      const id = data.slice("qpostnow:".length);
      const result = await postScheduledNow(id, bot, { notifyAdmin: false });
      if (!result.ok) {
        await ctx.answerCallbackQuery({
          text: result.error || "error",
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery({ text: "Published" });

      const link = config.channelUsername
        ? `https://t.me/${config.channelUsername}/${result.messageId}`
        : "";

      // If this was the scheduled-notify message (not browser), keep old caption style
      const isBrowser = (ctx.callbackQuery.message?.caption || "").includes(
        "Queue",
      );

      if (isBrowser) {
        const state = await loadQueue();
        const active = listActiveInOrder(state);
        if (active.length === 0) {
          try {
            await ctx.editMessageCaption({
              caption:
                `✅ Posted to @${config.channelUsername}` +
                (link ? `\n<a href="${link}">open</a>` : "") +
                `\n\n📋 Queue is empty.`,
              parse_mode: "HTML",
            });
          } catch {
            await ctx.reply(`✅ Posted.` + (link ? ` ${link}` : ""), {
              reply_markup: mainKeyboard(),
            });
          }
          return;
        }
        const captionMatch = ctx.callbackQuery.message?.caption || "";
        const m = captionMatch.match(/·\s*(\d+)\//);
        let idx = m ? Number(m[1]) - 1 : 0;
        if (idx >= active.length) idx = active.length - 1;
        if (idx < 0) idx = 0;
        await showQueueBrowser(ctx, idx, "edit");
        // also short notice
        try {
          await ctx.reply(
            `✅ To channel` +
              (link ? `: <a href="${link}">post</a>` : "") +
              ` · queue advanced`,
            {
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
              reply_markup: mainKeyboard(),
            },
          );
        } catch {
          /* ignore */
        }
        return;
      }

      const caption =
        `✅ <b>Posted now</b> to @${config.channelUsername}\n` +
        (link ? `<a href="${link}">open post</a>\n` : "") +
        `id: <code>${id}</code>` +
        (result.promoted
          ? `\n\nNext scheduled — see the new notification.`
          : `\n\nQueue is empty.`);
      try {
        await ctx.editMessageCaption({ caption, parse_mode: "HTML" });
      } catch {
        await ctx.reply(caption, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
      }
      return;
    }

    // Daily queue: cancel from notify
    if (data.startsWith("qcancel:")) {
      const id = data.slice("qcancel:".length);
      const result = await cancelQueueItem(id, bot);
      if (!result.ok) {
        await ctx.answerCallbackQuery({
          text: result.error || "error",
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery({ text: "Cancelled" });
      try {
        await ctx.editMessageCaption({
          caption:
            `❌ Post cancelled, removed from queue.\n` +
            `id: <code>${id}</code>` +
            (result.promoted
              ? `\nNext scheduled: <code>${result.promoted.id}</code>`
              : "\nQueue is empty."),
          parse_mode: "HTML",
        });
      } catch {
        await ctx.reply(`❌ Cancelled <code>${id}</code>`, {
          parse_mode: "HTML",
        });
      }
      return;
    }

    // Monthly top publish / cancel
    const [action, pendingId] = data.split(":");
    if (!pendingId || (action !== "publish" && action !== "cancel")) {
      await ctx.answerCallbackQuery({ text: "Unknown action" });
      return;
    }

    const pending = await loadPending(pendingId);
    if (!pending) {
      await ctx.answerCallbackQuery({
        text: "Preview expired or missing",
        show_alert: true,
      });
      return;
    }

    if (pending.status !== "pending") {
      await ctx.answerCallbackQuery({
        text: `Already ${pending.status}`,
        show_alert: true,
      });
      return;
    }

    if (action === "cancel") {
      await updatePending(pendingId, { status: "cancelled" });
      await ctx.answerCallbackQuery({ text: "Cancelled" });
      await ctx.editMessageText(
        `❌ Cancelled.\npending: <code>${pendingId}</code>`,
        { parse_mode: "HTML" },
      );
      return;
    }

    const chatId = pending.groupChatId || config.groupChatId;
    if (!chatId) {
      await ctx.answerCallbackQuery({
        text: "GROUP_CHAT_ID not set",
        show_alert: true,
      });
      return;
    }

    try {
      await ctx.answerCallbackQuery({ text: "Publishing…" });
      await ctx.editMessageText(`⏳ Publishing to @${pending.channelUsername}…`, {
        parse_mode: "HTML",
      });

      const photos = pending.photos.map((p) => ({ media: p.fileId }));
      const { pollMessage, albumMessages } = await publishAlbumAndPoll(
        bot.api,
        chatId,
        {
          photos,
          order: "poll-then-album",
          perPhotoCaptions: false,
          pollQuestion: pending.pollQuestion,
          pollOptions: pending.pollOptions,
          isAnonymous: pending.isAnonymous,
          allowsMultipleAnswers: pending.allowsMultipleAnswers,
          replyPollToAlbum: false,
        },
      );

      await updatePending(pendingId, { status: "published" });
      const pollId = pollMessage.message_id;
      const channelLink = pending.channelUsername
        ? `https://t.me/${pending.channelUsername}/${pollId}`
        : "";

      // After 5 days: stop poll, set winning photo as channel avatar
      let avatarNote = "";
      try {
        const { scheduleAvatarJob } = await import("./monthly/avatarJob.js");
        const job = await scheduleAvatarJob({
          chatId,
          pollMessageId: pollId,
          photoFileIds: pending.photos.map((p) => p.fileId),
          channelUsername: pending.channelUsername,
          rangeLabel: pending.rangeLabel,
          pollQuestion: pending.pollQuestion,
        });
        avatarNote = `Avatar job: <code>${job.id}</code> (after ${job.processAfter?.slice(0, 10) || "5 days"})`;
      } catch (err) {
        console.error("scheduleAvatarJob failed", err);
        avatarNote = `Avatar job not scheduled: ${escapeHtml(err.message || err)}`;
      }

      await ctx.editMessageText(
        [
          `✅ Posted to @${pending.channelUsername}`,
          `Poll: <code>${pollId}</code>`,
          `Album: <code>${albumMessages.map((m) => m.message_id).join(", ")}</code>`,
          channelLink ? `<a href="${channelLink}">open</a>` : "",
          avatarNote,
        ]
          .filter(Boolean)
          .join("\n"),
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      );
    } catch (err) {
      console.error("Publish failed:", err);
      await ctx.editMessageText(
        `⚠️ Error:\n<code>${escapeHtml(err.message || String(err))}</code>`,
        { parse_mode: "HTML" },
      );
    }
  });

  bot.catch((err) => {
    console.error("Bot error:", err.error ?? err);
  });

  return bot;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
