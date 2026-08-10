/**
 * Channel post format matched to historical @krasiviyded monthly polls.
 *
 * Observed pattern (e.g. https://t.me/krasiviyded/1653 + album after):
 *   1) Poll first
 *      question: "Лучший дед {month_genitive} {emoji}"
 *      options:  1️⃣ 2️⃣ 3️⃣ … (keycap emojis)
 *      anonymous, usually single-choice (June 2026 used multi once)
 *   2) Media group album immediately after — no captions on photos
 *      order of photos = order of poll options
 */

export const KEYCAP_OPTIONS = [
  "1️⃣",
  "2️⃣",
  "3️⃣",
  "4️⃣",
  "5️⃣",
  "6️⃣",
  "7️⃣",
  "8️⃣",
  "9️⃣",
  "🔟",
];

/** Month index 1–12 → Russian genitive (июля, июня, …) */
export const MONTH_GENITIVE_RU = [
  "",
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

/**
 * @param {number} month 1–12
 * @param {string} [emoji] default 👴 (used on several past polls)
 */
export function monthlyPollQuestion(month, emoji = "👴") {
  const name = MONTH_GENITIVE_RU[month];
  if (!name) throw new Error(`Invalid month: ${month}`);
  const suffix = emoji ? ` ${emoji}` : "";
  return `Лучший дед ${name}${suffix}`;
}

/**
 * @param {number} count 2–10
 */
export function monthlyPollOptions(count) {
  if (count < 2 || count > 10) {
    throw new Error("Poll options count must be 2–10");
  }
  return KEYCAP_OPTIONS.slice(0, count);
}

/**
 * Full channel-style payload fields for publishAlbumAndPoll.
 * @param {{ month: number, photoCount: number, emoji?: string }} opts
 */
export function channelMonthlyFormat(opts) {
  const n = opts.photoCount;
  return {
    order: "poll-then-album",
    albumCaption: null, // no caption on album (historical)
    perPhotoCaptions: false,
    pollQuestion: monthlyPollQuestion(opts.month, opts.emoji ?? "👴"),
    pollOptions: monthlyPollOptions(n),
    isAnonymous: true,
    // Most historical months: false. June 2026 used true once.
    allowsMultipleAnswers: false,
    replyPollToAlbum: false,
  };
}

/**
 * Admin ranking line with reaction count.
 * @param {import('./rank.js').RankablePost & { messageLink?: string }} post
 * @param {number} index0
 * @param {string} timeZone
 */
export function rankingLine(post, index0, timeZone) {
  const n = index0 + 1;
  const keycap = KEYCAP_OPTIONS[index0] || String(n);
  const date = post.date
    ? new Date(post.date).toLocaleDateString("ru-RU", {
        day: "numeric",
        month: "short",
        timeZone,
      })
    : "?";
  const link = post.messageLink || `#${post.id}`;
  // score = sum of all reactions ("likes" in product language)
  return `${keycap} <b>${post.score}</b> likes · ${date} · <a href="${link}">post</a>`;
}
