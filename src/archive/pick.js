/**
 * Choose a themed set of archive photos older than a year, skipping photos
 * and themes that were used recently.
 */
import {
  ARCHIVE_THEMES,
  MIN_THEME_PHOTOS,
  photoMatchesTheme,
} from "./themes.js";

const DAY_S = 86400;

/** An archive post has 3 to 5 photos. */
export const MIN_PICK = 3;
export const MAX_PICK = 5;

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * @param {object} opts
 * @param {{ id: string, date: number, tags: string[] }[]} opts.photos
 * @param {string[]} [opts.usedIds]
 * @param {string[]} [opts.recentThemes]
 * @param {string} [opts.themeKey] force a theme
 * @param {number} [opts.size] photos per post; random 3 to 5 when omitted
 * @param {number} [opts.minAgeDays]
 * @param {number} [opts.nowMs]
 * @param {() => number} [opts.rng]
 * @returns {{ theme: typeof ARCHIVE_THEMES[number], photos: object[] } | null}
 */
export function pickArchiveSet(opts) {
  const {
    photos,
    usedIds = [],
    recentThemes = [],
    themeKey,
    size,
    minAgeDays = 365,
    nowMs = Date.now(),
    rng = Math.random,
  } = opts;

  const used = new Set(usedIds);
  const cutoff = nowMs / 1000 - minAgeDays * DAY_S;
  const eligible = photos.filter((p) => p.date < cutoff && !used.has(p.id));

  const usable = ARCHIVE_THEMES.map((theme) => ({
    theme,
    matches: eligible.filter((p) => photoMatchesTheme(p, theme)),
  })).filter((c) => c.matches.length >= MIN_THEME_PHOTOS);

  let candidates = usable;
  if (themeKey) {
    candidates = usable.filter((c) => c.theme.key === themeKey);
  } else {
    const fresh = usable.filter((c) => !recentThemes.includes(c.theme.key));
    if (fresh.length > 0) candidates = fresh;
  }
  if (candidates.length === 0) return null;

  const chosen = candidates[Math.floor(rng() * candidates.length)];
  const n = Math.min(MAX_PICK, Math.max(MIN_PICK, size ?? MIN_PICK + Math.floor(rng() * 3)));
  return {
    theme: chosen.theme,
    photos: shuffle(chosen.matches, rng).slice(0, n),
  };
}

/**
 * Candidates for the manual photo picker: the currently selected photos
 * first, then random unused photos of the same theme, up to `count`.
 * `exclude` (photos shown last time) is only reused when nothing else is left.
 * @returns {object[]}
 */
export function poolForTheme({
  photos,
  theme,
  usedIds = [],
  selectedIds = [],
  exclude = [],
  count = 10,
  minAgeDays = 365,
  nowMs = Date.now(),
  rng = Math.random,
}) {
  const used = new Set(usedIds);
  const chosen = new Set(selectedIds);
  const cutoff = nowMs / 1000 - minAgeDays * DAY_S;
  const byId = new Map(photos.map((p) => [p.id, p]));
  const selected = selectedIds.map((id) => byId.get(id)).filter(Boolean);

  const eligible = photos.filter(
    (p) => p.date < cutoff && !used.has(p.id) && !chosen.has(p.id) && photoMatchesTheme(p, theme),
  );
  const seen = new Set(exclude);
  const fresh = shuffle(eligible.filter((p) => !seen.has(p.id)), rng);
  const reused = shuffle(eligible.filter((p) => seen.has(p.id)), rng);
  return [...selected, ...fresh, ...reused].slice(0, count);
}
