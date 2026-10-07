/**
 * Sunday archive post: every Sunday the bot DMs the admin a themed album of
 * old photos (older than a year) with a Gemini-written caption and
 * Post / Another / Skip buttons. Nothing reaches the channel without a tap.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InlineKeyboard, InputFile } from "grammy";
import { assertAdminId, config } from "../config.js";
import { localDayString, wallClock } from "../queue/time.js";
import { markChannelPosted } from "../scheduler/channelPulse.js";
import { incrementDayPost } from "../scheduler/dayState.js";
import { buildCaption } from "./caption.js";
import { pickArchiveSet } from "./pick.js";
import {
  createDraftOnce,
  loadArchiveState,
  loadDraft,
  recordArchivePost,
  saveDraft,
} from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, "..", "data", "archive-index.json");
const DRAFT_HOUR = Number(process.env.ARCHIVE_HOUR || 10);
const MAX_ATTEMPTS = 3;
const STALE_CLAIM_MS = 10 * 60 * 1000;

/** @type {{ id: string, date: number, url: string, link: string, tags: string[], desc: string }[] | null} */
let cachedPhotos = null;

function loadArchivePhotos() {
  if (!cachedPhotos) {
    cachedPhotos = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8")).photos;
  }
  return cachedPhotos;
}

function isSunday(tz, now) {
  const { y, m, d } = wallClock(tz, now);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0;
}

async function downloadPhoto(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`photo download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Send the set as one album with the caption on the first photo. */
async function sendAlbum(api, chatId, photos, caption) {
  const buffers = [];
  for (const p of photos) {
    try {
      buffers.push({ id: p.id, buf: await downloadPhoto(p.url) });
    } catch (err) {
      console.warn("archive photo skipped", p.id, err.message);
    }
  }
  if (buffers.length < 2) throw new Error("fewer than 2 archive photos downloaded");
  const media = buffers.map((b, i) => ({
    type: "photo",
    media: new InputFile(b.buf, `${b.id}.jpg`),
    ...(i === 0 ? { caption } : {}),
  }));
  return api.sendMediaGroup(chatId, media);
}

function controlKeyboard(id) {
  return new InlineKeyboard()
    .text("✅ Post", `arch:post:${id}`)
    .text("🔄 Another", `arch:swap:${id}`)
    .text("❌ Skip", `arch:skip:${id}`);
}

/**
 * Pick a set, write a caption, DM the admin the preview with buttons.
 * @param {{ api: import('grammy').Api, id: string, baseId?: string, round?: number, themeKey?: string, excludeThemes?: string[] }} opts
 */
export async function createArchiveDraft({
  api,
  id,
  baseId = id,
  round = 1,
  themeKey,
  excludeThemes = [],
}) {
  const adminId = assertAdminId();
  const state = await loadArchiveState();
  const set = pickArchiveSet({
    photos: loadArchivePhotos(),
    usedIds: state.usedIds,
    recentThemes: [...state.recentThemes, ...excludeThemes],
    themeKey,
  });
  if (!set) {
    await api.sendMessage(
      adminId,
      "🗃 Archive: no theme has enough unused photos older than a year.",
    );
    return null;
  }

  const { caption, source } = await buildCaption({
    theme: set.theme,
    photos: set.photos,
  });

  await sendAlbum(api, adminId, set.photos, caption);
  const control = await api.sendMessage(
    adminId,
    [
      "🗃 <b>Archive post draft</b>",
      `Theme: <b>${set.theme.phrase}</b> · ${set.photos.length} photos`,
      `Caption by: ${source}`,
      `id: <code>${id}</code>`,
      "",
      "Post it to the channel?",
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: controlKeyboard(id) },
  );

  const draft = {
    id,
    baseId,
    round,
    status: "pending",
    createdAt: new Date().toISOString(),
    theme: set.theme.key,
    caption,
    captionSource: source,
    photoIds: set.photos.map((p) => p.id),
    adminMessageId: control.message_id,
  };
  await saveDraft(draft);
  return draft;
}

/**
 * Called from the 15-minute queue tick. On Sunday after DRAFT_HOUR local it
 * creates today's draft once.
 * @returns {Promise<string[]>} actions
 */
export async function processArchiveTick({ bot, nowMs = Date.now() }) {
  const now = new Date(nowMs);
  const tz = config.timeZone;
  if (!isSunday(tz, now) || wallClock(tz, now).hour < DRAFT_HOUR) return [];

  const id = `sun-${localDayString(tz, now)}`;
  const existing = await loadDraft(id);
  const retryable =
    existing &&
    (existing.attempts || 1) < MAX_ATTEMPTS &&
    (existing.status === "failed" ||
      (existing.status === "creating" &&
        nowMs - new Date(existing.claimedAt || 0).getTime() > STALE_CLAIM_MS));
  if (existing && !retryable) return [];

  const attempts = (existing?.attempts || 0) + 1;
  if (!existing) {
    const claimed = await createDraftOnce({
      id,
      status: "creating",
      attempts,
      claimedAt: new Date(nowMs).toISOString(),
    });
    if (!claimed) return [];
  } else {
    await saveDraft({
      ...existing,
      status: "creating",
      attempts,
      claimedAt: new Date(nowMs).toISOString(),
    });
  }

  try {
    const draft = await createArchiveDraft({ api: bot.api, id });
    if (!draft) await saveDraft({ id, status: "empty", attempts });
    return [`archive_draft:${id}`];
  } catch (err) {
    console.error("archive draft failed", err);
    await saveDraft({ id, status: "failed", attempts, error: String(err.message || err) });
    try {
      await bot.api.sendMessage(
        assertAdminId(),
        `⚠️ Archive draft failed (attempt ${attempts}/${MAX_ATTEMPTS}): ${String(err.message || err).slice(0, 300)}`,
      );
    } catch {
      /* ignore */
    }
    return [`archive_error:${id}`];
  }
}

/**
 * Handle the arch:* buttons. Returns true if the callback was ours.
 * @param {import('grammy').Context} ctx
 */
export async function handleArchiveCallback(ctx) {
  const data = ctx.callbackQuery?.data || "";
  if (!data.startsWith("arch:")) return false;
  const [, action, id] = data.split(":");
  const draft = id ? await loadDraft(id) : null;
  if (!draft) {
    await ctx.answerCallbackQuery({ text: "Draft expired or missing", show_alert: true });
    return true;
  }
  if (draft.status !== "pending") {
    await ctx.answerCallbackQuery({ text: `Already ${draft.status}`, show_alert: true });
    return true;
  }

  const finish = async (status, text) => {
    await saveDraft({ ...draft, status });
    await ctx.editMessageText(text, { parse_mode: "HTML" }).catch(() => {});
  };

  if (action === "skip") {
    await ctx.answerCallbackQuery({ text: "Skipped" });
    await finish("skipped", `❌ Skipped archive draft <code>${id}</code>.`);
    return true;
  }

  if (action === "swap") {
    await ctx.answerCallbackQuery({ text: "Picking another theme…" });
    await finish("replaced", `🔄 Replaced <code>${id}</code> with a new draft.`);
    const baseId = draft.baseId || draft.id;
    const round = (draft.round || 1) + 1;
    await createArchiveDraft({
      api: ctx.api,
      id: `${baseId}-r${round}`,
      baseId,
      round,
      excludeThemes: [draft.theme],
    });
    return true;
  }

  if (action === "post") {
    const chatId = config.groupChatId;
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: "GROUP_CHAT_ID not set", show_alert: true });
      return true;
    }
    await ctx.answerCallbackQuery({ text: "Posting…" });
    await saveDraft({ ...draft, status: "posting" });
    try {
      const photos = loadArchivePhotos().filter((p) => draft.photoIds.includes(p.id));
      await sendAlbum(ctx.api, chatId, photos, draft.caption);
      await markChannelPosted("admin", id);
      await incrementDayPost("admin");
      await recordArchivePost(draft.theme, draft.photoIds);
      await finish("posted", `✅ Archive post published to @${config.channelUsername}.\n<code>${id}</code>`);
    } catch (err) {
      console.error("archive post failed", err);
      await saveDraft({ ...draft, status: "pending" });
      await ctx.editMessageText(
        `⚠️ Posting failed: ${String(err.message || err).slice(0, 300)}\nTap again to retry.`,
        { reply_markup: controlKeyboard(id) },
      ).catch(() => {});
    }
    return true;
  }

  await ctx.answerCallbackQuery({ text: "Unknown action" });
  return true;
}
