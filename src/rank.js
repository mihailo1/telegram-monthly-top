import { pathToFileURL } from "node:url";

/**
 * Rank posts by total reaction count.
 * - Prefer ~topBase items
 * - Expand while the next item ties the last taken score
 * - Never exceed topMax (Telegram poll + media group hard limit = 10)
 *
 * @typedef {{ id: string|number, score: number, date?: Date|string|number, caption?: string, photoUrl?: string, photoPath?: string }} RankablePost
 */

/**
 * @param {RankablePost[]} posts
 * @param {{ topBase?: number, topMax?: number }} [opts]
 * @returns {RankablePost[]}
 */
export function rankTopPosts(posts, opts = {}) {
  const topBase = opts.topBase ?? 5;
  const topMax = opts.topMax ?? 10;

  if (topBase < 1 || topMax < 1) {
    throw new Error("topBase and topMax must be >= 1");
  }
  if (topBase > topMax) {
    throw new Error("topBase cannot be greater than topMax");
  }

  const sorted = [...posts].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Stable secondary: newer first if dates present
    const da = a.date != null ? new Date(a.date).getTime() : 0;
    const db = b.date != null ? new Date(b.date).getTime() : 0;
    return db - da;
  });

  if (sorted.length === 0) return [];

  const take = Math.min(topBase, sorted.length);
  let end = take;

  if (end < sorted.length) {
    const threshold = sorted[end - 1].score;
    while (end < sorted.length && end < topMax && sorted[end].score === threshold) {
      end += 1;
    }
  }

  return sorted.slice(0, Math.min(end, topMax));
}

// Demo when run directly: npm run rank-demo
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const demo = [
    { id: 1, score: 40, caption: "A" },
    { id: 2, score: 30, caption: "B" },
    { id: 3, score: 30, caption: "C" },
    { id: 4, score: 30, caption: "D" },
    { id: 5, score: 20, caption: "E" },
    { id: 6, score: 20, caption: "F" },
    { id: 7, score: 10, caption: "G" },
  ];
  console.log(rankTopPosts(demo, { topBase: 5, topMax: 10 }));
}
