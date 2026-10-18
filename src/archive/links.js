/**
 * Source-post links for the Sunday archive album. Each photo gets its
 * position in the album as a keycap emoji with the t.me link of the original
 * post underneath, so a reader can jump to the post behind any photo.
 */

/** Telegram caps a media caption at 1024 characters. */
export const CAPTION_LIMIT = 1024;

const KEYCAPS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

/** Keycap emoji for a 1-based album position; plain "n." past ten. */
export function positionEmoji(n) {
  return KEYCAPS[n - 1] ?? `${n}.`;
}

/**
 * Link lines for photos in album order. The number is the photo's position in
 * the album, so a photo without a link keeps its number and is just skipped.
 * @param {{ link?: string }[]} photos
 */
export function linksBlock(photos) {
  return photos
    .flatMap((p, i) => (p.link ? [`${positionEmoji(i + 1)}\n${p.link}`] : []))
    .join("\n");
}

/**
 * Album caption followed by the link block. The text part is trimmed when the
 * total would pass the caption limit, the links are always kept whole.
 * @param {string} caption
 * @param {{ link?: string }[]} photos photos in the order they are sent
 */
export function composeCaption(caption, photos) {
  const links = linksBlock(photos);
  if (!links) return caption;
  const budget = CAPTION_LIMIT - links.length - 2;
  const text = caption.length > budget ? `${caption.slice(0, Math.max(0, budget - 1))}…` : caption;
  return text ? `${text}\n\n${links}` : links;
}
