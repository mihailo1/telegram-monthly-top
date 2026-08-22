/**
 * Precompute embeddings for reply-phrases.json (run locally once).
 * Output: src/data/reply-phrase-embeddings.json
 *
 *   npm run phrases:embed
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EMBED_MODEL,
  EMBEDDINGS_PATH,
  embedText,
  getExtractor,
} from "../src/phraseEmbed.js";
import { loadReplyPhrases } from "../src/replyPhrases.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log("Loading model", EMBED_MODEL, "…");
await getExtractor();
const phrases = loadReplyPhrases();
console.log("Phrases:", phrases.length);

const vectors = [];
for (let i = 0; i < phrases.length; i++) {
  const v = await embedText(phrases[i], "passage");
  vectors.push(v);
  if ((i + 1) % 20 === 0 || i === phrases.length - 1) {
    console.log(`  embedded ${i + 1}/${phrases.length} (dim=${v.length})`);
  }
}

const out = {
  model: EMBED_MODEL,
  dim: vectors[0]?.length || 0,
  createdAt: new Date().toISOString(),
  phrases,
  vectors,
};

fs.mkdirSync(path.dirname(EMBEDDINGS_PATH), { recursive: true });
fs.writeFileSync(EMBEDDINGS_PATH, JSON.stringify(out));
const mb = (fs.statSync(EMBEDDINGS_PATH).size / 1024 / 1024).toFixed(2);
console.log("Wrote", EMBEDDINGS_PATH, `(${mb} MB)`);
