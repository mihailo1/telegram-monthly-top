/**
 * Build src/data/archive-index.json from the krasiviyded-search photo index.
 * Usage: node scripts/build-archive-index.mjs [path/to/index.json]
 *
 * Keeps only what the Sunday archive post needs: date, public image URL,
 * message link, Russian tags and a short description.
 */
import fs from "node:fs";
import path from "node:path";

const SOURCE = path.resolve(
  process.argv[2] || "../krasiviyded-search/data/index.json",
);
const OUT = path.resolve("src/data/archive-index.json");
const CYRILLIC = /[а-яё]/i;

const raw = JSON.parse(fs.readFileSync(SOURCE, "utf8"));
const photos = (raw.photos || [])
  .filter((p) => p.imageUrl && p.date)
  .map((p) => ({
    id: p.id,
    date: p.date,
    url: p.imageUrl,
    link: p.messageLink || "",
    tags: [
      ...new Set(
        (p.tags || [])
          .filter((t) => CYRILLIC.test(t))
          .map((t) => t.toLowerCase().trim()),
      ),
    ],
    desc: String(p.description || "").slice(0, 240),
  }));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ builtAt: new Date().toISOString(), photos }));
console.log(`archive index: ${photos.length} photos -> ${OUT}`);
