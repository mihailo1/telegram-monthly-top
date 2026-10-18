/**
 * Source-post links for the Sunday archive album. The caption ends with one
 * line of keycap emoji, one per photo in album order, and each emoji is itself
 * a link to the original post. The result is HTML: send it with
 * `parse_mode: "HTML"`.
 */

/** Telegram caps a media caption at 1024 characters (visible text, not markup). */
export const CAPTION_LIMIT = 1024;

const KEYCAPS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

/** Keycap emoji for a 1-based album position; plain "n." past ten. */
export function positionEmoji(n) {
  return KEYCAPS[n - 1] ?? `${n}.`;
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, "&quot;");

/**
 * Emoji line for photos in album order. The emoji is the photo's position in
 * the album, so a photo without a link keeps its number and is just skipped.
 * @param {{ link?: string }[]} photos
 * @returns {{ html: string, visibleLength: number }}
 */
export function linksLine(photos) {
  const items = photos.flatMap((p, i) => (p.link ? [{ emoji: positionEmoji(i + 1), link: p.link }] : []));
  return {
    html: items.map((it) => `<a href="${escapeAttr(it.link)}">${it.emoji}</a>`).join(" "),
    visibleLength: items.map((it) => it.emoji).join(" ").length,
  };
}

/**
 * Album caption followed by the emoji link line, as HTML. The text part is
 * trimmed when the visible total would pass the caption limit.
 * @param {string} caption plain text
 * @param {{ link?: string }[]} photos photos in the order they are sent
 */
export function composeCaption(caption, photos) {
  const { html, visibleLength } = linksLine(photos);
  if (!html) return escapeHtml(caption);
  const budget = CAPTION_LIMIT - visibleLength - 2;
  const text = caption.length > budget ? `${caption.slice(0, Math.max(0, budget - 1))}…` : caption;
  return text ? `${escapeHtml(text)}\n\n${html}` : html;
}
