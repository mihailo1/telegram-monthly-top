/**
 * Admin menu: persistent reply keyboard plus the Today dashboard, the Archive
 * theme picker and the More panel. Labels are Russian on purpose (admin UI
 * copy); code and comments stay English.
 */
import { InlineKeyboard, Keyboard } from "grammy";
import { getMuted, toggleMuted } from "./alerts.js";
import { ARCHIVE_THEMES } from "./archive/themes.js";
import { createArchiveDraft } from "./archive/tick.js";
import { config } from "./config.js";
import { countMembersActive, loadMembersQueue } from "./members/store.js";
import { cancelQueueItem, postScheduledNow } from "./queue/process.js";
import { countActive, getScheduled, loadQueue } from "./queue/store.js";
import { addDays, formatLocal, localDayString, wallClock } from "./queue/time.js";
import { loadChannelPulse } from "./scheduler/channelPulse.js";
import { versionLine } from "./version.js";

export const BTN = {
  today: "📅 Сегодня",
  archive: "🗃 Архив",
  queue: "📋 Очередь",
  members: "👥 От подписчиков",
  preview: "📊 Месячный топ",
  more: "⚙️ Ещё",
};

export function mainKeyboard() {
  return new Keyboard()
    .text(BTN.today)
    .text(BTN.archive)
    .row()
    .text(BTN.queue)
    .text(BTN.members)
    .row()
    .text(BTN.preview)
    .text(BTN.more)
    .resized()
    .persistent();
}

export const BOT_COMMANDS = [
  { command: "today", description: "Сегодня: статус и следующий пост" },
  { command: "archive", description: "Архивная подборка" },
  { command: "queue", description: "Очередь фото" },
  { command: "members", description: "Фото от подписчиков" },
  { command: "preview", description: "Месячный топ" },
  { command: "version", description: "Версия бота" },
  { command: "help", description: "Помощь" },
];

const ARCHIVE_DRAFT_HOUR = Number(process.env.ARCHIVE_HOUR || 10);

export function helpText() {
  return [
    "<b>Помощь</b>",
    "",
    "📅 <b>Сегодня</b>: следующий пост, очередь, фото от подписчиков",
    "🗃 <b>Архив</b>: подборка старых фото. По воскресеньям бот сам присылает черновик",
    "📋 <b>Очередь</b>: твои фото и видео, можно запостить сейчас или удалить",
    "👥 <b>От подписчиков</b>: фото из директа канала",
    "📊 <b>Месячный топ</b>: превью топа месяца, 5 числа бот присылает его сам",
    "⚙️ <b>Ещё</b>: помощь, версия, уведомления",
    "",
    `Пришли сюда фото или видео, и они попадут в очередь. Один пост в день, с 10:00 до 22:00 по ${config.timeZone === "Europe/Moscow" ? "МСК" : config.timeZone}.`,
  ].join("\n");
}

function untilText(ms) {
  const abs = Math.abs(ms);
  const mins = Math.round(abs / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const span = h >= 24 ? `${Math.floor(h / 24)} д ${h % 24} ч` : h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
  return ms >= 0 ? `через ${span}` : `просрочен на ${span}`;
}

function dayLabel(date, tz) {
  return date.toLocaleDateString("ru-RU", { timeZone: tz, day: "numeric", month: "long" });
}

function nextSundayLabel(tz, now) {
  const { y, m, d, hour } = wallClock(tz, now);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  let ahead = (7 - dow) % 7;
  if (ahead === 0 && hour >= ARCHIVE_DRAFT_HOUR) ahead = 7;
  const day = addDays(localDayString(tz, now), ahead);
  const [yy, mm, dd] = day.split("-").map(Number);
  const label = new Date(Date.UTC(yy, mm - 1, dd)).toLocaleDateString("ru-RU", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
  });
  return ahead === 0 ? `сегодня, после ${ARCHIVE_DRAFT_HOUR}:00` : `вс, ${label}, после ${ARCHIVE_DRAFT_HOUR}:00`;
}

const KIND_LABEL = { admin: "из очереди", members: "от подписчиков" };

/** Dashboard text and buttons for "Сегодня". */
export async function todayView(nowMs = Date.now()) {
  const tz = config.timeZone;
  const now = new Date(nowMs);
  const state = await loadQueue();
  const active = countActive(state);
  const scheduled = getScheduled(state);
  const membersActive = countMembersActive((await loadMembersQueue()).items);
  const pulse = await loadChannelPulse();

  const lines = [`📅 <b>Сегодня</b> · ${formatLocal(now, tz)}`, ""];
  if (scheduled?.postAt) {
    const at = new Date(scheduled.postAt);
    lines.push(`Следующий пост: <b>${formatLocal(at, tz)}</b> (${untilText(at.getTime() - nowMs)})`);
  } else {
    lines.push("Следующий пост: не назначен");
  }
  lines.push(
    active > 0
      ? `В очереди: <b>${active}</b> (хватит примерно до ${dayLabel(new Date(nowMs + active * 86400000), tz)})`
      : "В очереди: <b>пусто</b>, пришли фото",
  );
  lines.push(`От подписчиков ждёт: <b>${membersActive}</b>`);
  if (pulse.lastPostedAt) {
    const kind = KIND_LABEL[pulse.lastKind];
    lines.push(`Последний пост: ${formatLocal(pulse.lastPostedAt, tz)}${kind ? ` (${kind})` : ""}`);
  }
  lines.push(`Воскресный архив: ${nextSundayLabel(tz, now)}`, `Версия: ${versionLine()}`);

  const kb = new InlineKeyboard();
  if (scheduled) {
    kb.text("✅ Запостить сейчас", `today:post:${scheduled.id}`)
      .text("❌ Отменить следующий", `today:cancel:${scheduled.id}`)
      .row();
  }
  kb.text("🔄 Обновить", "today:refresh");
  return { text: lines.join("\n"), keyboard: kb };
}

export function archiveMenuView() {
  const kb = new InlineKeyboard().text("🎲 Удиви меня", "amenu:random").row();
  ARCHIVE_THEMES.forEach((t, i) => {
    const label = t.phrase.charAt(0).toUpperCase() + t.phrase.slice(1);
    kb.text(label, `amenu:t:${t.key}`);
    if (i % 2 === 1) kb.row();
  });
  return {
    text: "🗃 <b>Архив</b>\nФото старше года. Выбери тему или тяни наугад, дальше будет черновик с кнопками.",
    keyboard: kb,
  };
}

export async function moreView() {
  const muted = await getMuted();
  const mark = (cat) => (muted[cat] ? "🔕 выкл" : "✅ вкл");
  const keyboard = new InlineKeyboard()
    .text("ℹ️ Помощь", "more:help")
    .text("🏷 Версия", "more:version")
    .row()
    .text(`🪫 Очередь на исходе: ${mark("low")}`, "more:toggle:low")
    .row()
    .text(`🚀 Уведомления о деплое: ${mark("deploy")}`, "more:toggle:deploy");
  return { text: "⚙️ <b>Ещё</b>", keyboard };
}

async function safeEdit(ctx, view) {
  try {
    await ctx.editMessageText(view.text, {
      parse_mode: "HTML",
      reply_markup: view.keyboard,
    });
  } catch {
    // "message is not modified" when nothing changed
  }
}

/**
 * Handle today:*, more:* and amenu:* buttons. Returns true if handled.
 * @param {import('grammy').Context} ctx
 */
export async function handleMenuCallback(ctx) {
  const data = ctx.callbackQuery?.data || "";
  const [prefix, action, arg] = data.split(":");
  if (!["today", "more", "amenu"].includes(prefix)) return false;

  if (prefix === "today") {
    if (action === "refresh") {
      await ctx.answerCallbackQuery();
    } else if (action === "post") {
      const r = await postScheduledNow(arg, ctx, { notifyAdmin: false });
      await ctx.answerCallbackQuery({ text: r.ok ? "Опубликовано" : r.error || "Ошибка", show_alert: !r.ok });
    } else if (action === "cancel") {
      const r = await cancelQueueItem(arg, ctx);
      await ctx.answerCallbackQuery({ text: r.ok ? "Отменено" : r.error || "Ошибка", show_alert: !r.ok });
    }
    await safeEdit(ctx, await todayView());
    return true;
  }

  if (prefix === "more") {
    if (action === "help") {
      await ctx.answerCallbackQuery();
      await ctx.reply(helpText(), { parse_mode: "HTML" });
    } else if (action === "version") {
      await ctx.answerCallbackQuery();
      await ctx.reply(`Версия ${versionLine()}`);
    } else if (action === "toggle" && ["low", "deploy"].includes(arg)) {
      const nowMuted = await toggleMuted(arg);
      await ctx.answerCallbackQuery({ text: nowMuted ? "Выключено" : "Включено" });
      await safeEdit(ctx, await moreView());
    } else {
      await ctx.answerCallbackQuery();
    }
    return true;
  }

  // amenu: archive draft on demand
  await ctx.answerCallbackQuery({ text: "Готовлю подборку…" });
  try {
    await createArchiveDraft({
      api: ctx.api,
      id: `man-${Date.now().toString(36)}`,
      themeKey: action === "t" ? arg : undefined,
    });
  } catch (err) {
    await ctx.reply(`Не получилось собрать подборку: ${String(err.message || err).slice(0, 300)}`);
  }
  return true;
}
