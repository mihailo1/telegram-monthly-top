/**
 * Sunday archive post: every Sunday the bot DMs the admin a themed album of
 * 3 to 5 old photos (older than a year) with a Gemini-written caption. The
 * admin can post it, rewrite the caption, regenerate it, pick specific photos
 * or switch theme. Only posted photos are marked used, so everything the
 * admin did not pick stays available for other sets. Nothing reaches the
 * channel without a tap.
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
import { MAX_PICK, MIN_PICK, pickArchiveSet, poolForTheme } from "./pick.js";
import {
  clearAwaiting,
  createDraftOnce,
  getAwaiting,
  loadArchiveState,
  loadDraft,
  recordArchivePost,
  saveDraft,
  setAwaiting,
} from "./state.js";
import { ARCHIVE_THEMES } from "./themes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, "..", "data", "archive-index.json");
const DRAFT_HOUR = Number(process.env.ARCHIVE_HOUR || 10);
const MAX_ATTEMPTS = 3;
const STALE_CLAIM_MS = 10 * 60 * 1000;
const AWAITING_TTL_MS = 15 * 60 * 1000;
const POOL_SIZE = 10;

/** @type {{ id: string, date: number, url: string, link: string, tags: string[], desc: string }[] | null} */
let cachedPhotos = null;

function loadArchivePhotos() {
  if (!cachedPhotos) {
    cachedPhotos = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8")).photos;
  }
  return cachedPhotos;
}

function photosByIds(ids) {
  const byId = new Map(loadArchivePhotos().map((p) => [p.id, p]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

const themeByKey = (key) => ARCHIVE_THEMES.find((t) => t.key === key);

function isSunday(tz, now) {
  const { y, m, d } = wallClock(tz, now);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0;
}

async function downloadPhoto(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`photo download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Send photos as one album. With `numbered` every photo is captioned with its
 * 1-based position (the picker); otherwise the caption goes on the first one.
 */
async function sendAlbum(api, chatId, photos, caption, { numbered = false } = {}) {
  const downloaded = await Promise.all(
    photos.map(async (p, i) => {
      try {
        return { n: i + 1, id: p.id, buf: await downloadPhoto(p.url) };
      } catch (err) {
        console.warn("archive photo skipped", p.id, err.message);
        return null;
      }
    }),
  );
  const ok = downloaded.filter(Boolean);
  if (ok.length < 2) throw new Error("fewer than 2 archive photos downloaded");
  const media = ok.map((b, i) => ({
    type: "photo",
    media: new InputFile(b.buf, `${b.id}.jpg`),
    ...(numbered ? { caption: String(b.n) } : i === 0 ? { caption } : {}),
  }));
  return api.sendMediaGroup(chatId, media);
}

function captionSourceLabel(source) {
  if (source === "manual") return "твоя";
  if (source === "template") return "шаблон";
  return "Gemini";
}

function controlText(draft) {
  const theme = themeByKey(draft.theme);
  return [
    "🗃 <b>Черновик архивного поста</b>",
    `Тема: <b>${theme?.phrase || draft.theme}</b> · ${draft.photoIds.length} фото`,
    `Подпись: ${captionSourceLabel(draft.captionSource)}`,
    `id: <code>${draft.id}</code>`,
    "",
    "Запостить в канал?",
  ].join("\n");
}

function controlKeyboard(id) {
  return new InlineKeyboard()
    .text("✅ Запостить", `arch:post:${id}`)
    .text("❌ Пропустить", `arch:skip:${id}`)
    .row()
    .text("✏️ Своя подпись", `arch:edit:${id}`)
    .text("🤖 Новая подпись", `arch:cap:${id}`)
    .row()
    .text("🖼 Выбрать фото", `arch:pics:${id}`)
    .text("🔄 Другая тема", `arch:swap:${id}`);
}

/** Send the album (with caption) and the control message, then save the ids. */
async function sendPreview(api, draft) {
  const adminId = assertAdminId();
  const albumMsgs = await sendAlbum(api, adminId, photosByIds(draft.photoIds), draft.caption);
  const control = await api.sendMessage(adminId, controlText(draft), {
    parse_mode: "HTML",
    reply_markup: controlKeyboard(draft.id),
  });
  draft.albumMessageIds = albumMsgs.map((m) => m.message_id);
  draft.adminMessageId = control.message_id;
  await saveDraft(draft);
}

/** Change the caption of the already sent preview album in place. */
async function applyCaption(api, draft) {
  const adminId = assertAdminId();
  try {
    await api.editMessageCaption(adminId, draft.albumMessageIds[0], {
      caption: draft.caption,
    });
    await api
      .editMessageText(adminId, draft.adminMessageId, controlText(draft), {
        parse_mode: "HTML",
        reply_markup: controlKeyboard(draft.id),
      })
      .catch(() => {});
    await saveDraft(draft);
  } catch (err) {
    console.warn("caption edit failed, resending preview", err.message);
    await sendPreview(api, draft);
  }
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
      "🗃 В архиве нет темы с достаточным числом неиспользованных фото старше года.",
    );
    return null;
  }

  const { caption, source } = await buildCaption({
    theme: set.theme,
    photos: set.photos,
  });

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
  };
  await sendPreview(api, draft);
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
        `⚠️ Не получилось собрать архивный черновик (попытка ${attempts}/${MAX_ATTEMPTS}): ${String(err.message || err).slice(0, 300)}`,
      );
    } catch {
      /* ignore */
    }
    return [`archive_error:${id}`];
  }
}

// ---------------------------------------------------------------- picker

function pickerText(draft) {
  const n = (draft.pickSelected || []).length;
  return [
    "🖼 <b>Выбор фото</b>",
    `Нажимай номера, чтобы выбрать от ${MIN_PICK} до ${MAX_PICK} фото. Остальные останутся для других подборок.`,
    `Выбрано: <b>${n}</b>`,
  ].join("\n");
}

function pickerKeyboard(draft) {
  const selected = new Set(draft.pickSelected || []);
  const kb = new InlineKeyboard();
  draft.pool.forEach((photoId, i) => {
    kb.text(`${selected.has(photoId) ? "✅" : ""}${i + 1}`, `arch:tog:${draft.id}:${i + 1}`);
    if (i % 5 === 4) kb.row();
  });
  kb.row()
    .text(`Готово (${selected.size})`, `arch:done:${draft.id}`)
    .text("🔄 Другие", `arch:more:${draft.id}`)
    .text("↩️ Назад", `arch:back:${draft.id}`);
  return kb;
}

/** Send a numbered candidate album and the picker controls. */
async function startPicker(api, draft) {
  const adminId = assertAdminId();
  const state = await loadArchiveState();
  const selectedIds = draft.pickSelected || draft.photoIds;
  const pool = poolForTheme({
    photos: loadArchivePhotos(),
    theme: themeByKey(draft.theme),
    usedIds: state.usedIds,
    selectedIds,
    exclude: draft.pool || [],
    count: POOL_SIZE,
  });
  draft.pool = pool.map((p) => p.id);
  draft.pickSelected = selectedIds.filter((id) => draft.pool.includes(id));

  await sendAlbum(api, adminId, pool, "", { numbered: true });
  const control = await api.sendMessage(adminId, pickerText(draft), {
    parse_mode: "HTML",
    reply_markup: pickerKeyboard(draft),
  });
  draft.pickerMessageId = control.message_id;
  await saveDraft(draft);
}

// ------------------------------------------------------- caption by text

/**
 * If the admin was asked for a caption, take this text message as the new
 * caption. Returns true when the message was consumed.
 * @param {import('grammy').Context} ctx
 */
export async function consumeCaptionInput(ctx) {
  const awaiting = await getAwaiting();
  if (!awaiting) return false;
  if (Date.now() - new Date(awaiting.at).getTime() > AWAITING_TTL_MS) {
    await clearAwaiting();
    return false;
  }
  await clearAwaiting();
  const draft = await loadDraft(awaiting.draftId);
  if (!draft || draft.status !== "pending") {
    await ctx.reply("Этот черновик уже не активен.");
    return true;
  }
  draft.caption = ctx.message.text.trim().slice(0, 1000);
  draft.captionSource = "manual";
  await applyCaption(ctx.api, draft);
  await ctx.reply("✏️ Подпись обновлена.");
  return true;
}

export async function cancelCaptionInput(ctx) {
  if (await getAwaiting()) {
    await clearAwaiting();
    await ctx.reply("Ок, подпись не меняю.");
  }
}

// -------------------------------------------------------------- buttons

/**
 * Handle the arch:* buttons. Returns true if the callback was ours.
 * @param {import('grammy').Context} ctx
 */
export async function handleArchiveCallback(ctx) {
  const data = ctx.callbackQuery?.data || "";
  if (!data.startsWith("arch:")) return false;
  const [, action, id, arg] = data.split(":");
  const draft = id ? await loadDraft(id) : null;
  if (!draft) {
    await ctx.answerCallbackQuery({ text: "Черновик устарел или не найден", show_alert: true });
    return true;
  }
  if (draft.status !== "pending") {
    await ctx.answerCallbackQuery({ text: `Уже: ${draft.status}`, show_alert: true });
    return true;
  }

  const finish = async (status, text) => {
    await saveDraft({ ...draft, status });
    await ctx.editMessageText(text, { parse_mode: "HTML" }).catch(() => {});
  };

  if (action === "skip") {
    await ctx.answerCallbackQuery({ text: "Пропущено" });
    await finish("skipped", `❌ Архивный черновик <code>${id}</code> пропущен.`);
    return true;
  }

  if (action === "swap") {
    await ctx.answerCallbackQuery({ text: "Ищу другую тему…" });
    await finish("replaced", `🔄 <code>${id}</code> заменён новым черновиком.`);
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

  if (action === "cap") {
    await ctx.answerCallbackQuery({ text: "Пишу новую подпись…" });
    const { caption, source } = await buildCaption({
      theme: themeByKey(draft.theme),
      photos: photosByIds(draft.photoIds),
    });
    draft.caption = caption;
    draft.captionSource = source;
    await applyCaption(ctx.api, draft);
    return true;
  }

  if (action === "edit") {
    await setAwaiting(id);
    await ctx.answerCallbackQuery();
    await ctx.reply("✏️ Пришли новую подпись одним сообщением. Отмена: /cancel");
    return true;
  }

  if (action === "pics") {
    await ctx.answerCallbackQuery({ text: "Собираю варианты…" });
    draft.pickSelected = draft.photoIds;
    draft.pool = [];
    await startPicker(ctx.api, draft);
    return true;
  }

  if (action === "more") {
    await ctx.answerCallbackQuery({ text: "Другие варианты…" });
    await ctx.editMessageText("🔄 Подобрал другие варианты ниже.").catch(() => {});
    await startPicker(ctx.api, draft);
    return true;
  }

  if (action === "tog") {
    const photoId = (draft.pool || [])[Number(arg) - 1];
    if (!photoId) {
      await ctx.answerCallbackQuery({ text: "Нет такого фото", show_alert: true });
      return true;
    }
    const sel = new Set(draft.pickSelected || []);
    if (sel.has(photoId)) {
      sel.delete(photoId);
    } else if (sel.size >= MAX_PICK) {
      await ctx.answerCallbackQuery({ text: `Максимум ${MAX_PICK} фото`, show_alert: true });
      return true;
    } else {
      sel.add(photoId);
    }
    draft.pickSelected = draft.pool.filter((pid) => sel.has(pid));
    await saveDraft(draft);
    await ctx.answerCallbackQuery();
    await ctx
      .editMessageText(pickerText(draft), {
        parse_mode: "HTML",
        reply_markup: pickerKeyboard(draft),
      })
      .catch(() => {});
    return true;
  }

  if (action === "back") {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("↩️ Выбор отменён, черновик остался прежним.").catch(() => {});
    draft.pool = [];
    draft.pickSelected = [];
    await saveDraft(draft);
    return true;
  }

  if (action === "done") {
    const count = (draft.pickSelected || []).length;
    if (count < MIN_PICK || count > MAX_PICK) {
      await ctx.answerCallbackQuery({
        text: `Нужно от ${MIN_PICK} до ${MAX_PICK} фото, сейчас ${count}`,
        show_alert: true,
      });
      return true;
    }
    await ctx.answerCallbackQuery({ text: "Собираю черновик…" });
    await ctx.editMessageText("✅ Выбор сохранён, новый черновик ниже.").catch(() => {});
    await ctx.api
      .editMessageText(
        assertAdminId(),
        draft.adminMessageId,
        `🔄 Заменено новым вариантом ниже: <code>${id}</code>`,
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    draft.photoIds = draft.pickSelected;
    draft.pool = [];
    draft.pickSelected = [];
    await sendPreview(ctx.api, draft);
    return true;
  }

  if (action === "post") {
    const chatId = config.groupChatId;
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: "GROUP_CHAT_ID не задан", show_alert: true });
      return true;
    }
    await ctx.answerCallbackQuery({ text: "Публикую…" });
    await saveDraft({ ...draft, status: "posting" });
    try {
      await sendAlbum(ctx.api, chatId, photosByIds(draft.photoIds), draft.caption);
      await markChannelPosted("admin", id);
      await incrementDayPost("admin");
      await recordArchivePost(draft.theme, draft.photoIds);
      await finish("posted", `✅ Архивный пост опубликован в @${config.channelUsername}.\n<code>${id}</code>`);
    } catch (err) {
      console.error("archive post failed", err);
      await saveDraft({ ...draft, status: "pending" });
      await ctx
        .editMessageText(
          `⚠️ Не получилось опубликовать: ${String(err.message || err).slice(0, 300)}\nНажми ещё раз, чтобы повторить.`,
          { reply_markup: controlKeyboard(id) },
        )
        .catch(() => {});
    }
    return true;
  }

  await ctx.answerCallbackQuery({ text: "Неизвестное действие" });
  return true;
}
