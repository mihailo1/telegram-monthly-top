/**
 * Precompute e5 embeddings for reply-phrases.json (run locally).
 * Requires: npm i @xenova/transformers
 *
 *   npm run phrases:embed
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadReplyPhrases } from "../src/replyPhrases.js";

const EMBED_MODEL = "Xenova/multilingual-e5-small";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(
  __dirname,
  "..",
  "src",
  "data",
  "reply-phrase-embeddings.json",
);

const { pipeline, env } = await import("@xenova/transformers");
env.cacheDir = process.env.TRANSFORMERS_CACHE || path.join(__dirname, "..", ".transformers-cache");

console.log("Loading teacher", EMBED_MODEL, "…");
const extractor = await pipeline("feature-extraction", EMBED_MODEL, {
  quantized: true,
});

async function embedPassage(text) {
  const out = await extractor(`passage: ${text}`, {
    pooling: "mean",
    normalize: true,
  });
  if (out?.data) return Array.from(out.data, Number);
  if (Array.isArray(out)) {
    const row = Array.isArray(out[0]) ? out[0] : out;
    return row.map(Number);
  }
  throw new Error("unexpected embedding output");
}

const phrases = loadReplyPhrases();
console.log("Phrases:", phrases.length);
const vectors = [];
for (let i = 0; i < phrases.length; i++) {
  vectors.push(await embedPassage(phrases[i]));
  if ((i + 1) % 20 === 0 || i === phrases.length - 1) {
    console.log(`  embedded ${i + 1}/${phrases.length}`);
  }
}

const payload = {
  model: EMBED_MODEL,
  dim: vectors[0].length,
  createdAt: new Date().toISOString(),
  phrases,
  vectors,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload));
console.log(
  "Wrote",
  OUT,
  `(${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB)`,
);
