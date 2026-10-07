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
 * @param {number} [opts.size] photos per post (2 to 10)
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
    size = 8,
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
  const n = Math.min(10, Math.max(2, size));
  return {
    theme: chosen.theme,
    photos: shuffle(chosen.matches, rng).slice(0, n),
  };
}
