/**
 * Phrase picker facade — **no neural net on Vercel runtime**.
 *
 * Modes (PHRASE_PICKER):
 *   distill — hashed n-grams → tiny linear projector ≈ e5, cosine vs
 *             precomputed reply-phrase-embeddings.json (best economical)
 *   bm25    — classic BM25 over tokens/char-grams
 *   random  — uniform random
 *   embed   — alias of distill (legacy name; Xenova not loaded at runtime)
 *
 * Default: distill if projector + e5 index exist, else bm25, else random.
 *
 * Train projector offline: `npm run phrases:train` (uses Xenova as teacher).
 * Precompute e5 phrase vectors: `npm run phrases:embed`
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomReplyPhrase } from "./replyPhrases.js";
import { bm25Top1 } from "./phraseBm25.js";
import { distillTop1, loadProjector, PROJECTOR_PATH } from "./phraseDistill.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EMBEDDINGS_PATH = path.join(
  __dirname,
  "data",
  "reply-phrase-embeddings.json",
);
export const EMBED_MODEL = "Xenova/multilingual-e5-small";

function pickerMode() {
  const m = (process.env.PHRASE_PICKER || "").toLowerCase().trim();
  if (m === "random" || m === "bm25" || m === "distill" || m === "embed") {
    return m === "embed" ? "distill" : m;
  }
  if (fs.existsSync(PROJECTOR_PATH) && fs.existsSync(EMBEDDINGS_PATH)) {
    return "distill";
  }
  return "bm25";
}

/**
 * @param {string} [userText]
 * @returns {Promise<string>}
 */
export async function pickReplyPhrase(userText) {
  const text = (userText || "").trim();
  const mode = pickerMode();

  if (!text || mode === "random") {
    return randomReplyPhrase();
  }

  if (mode === "distill") {
    // Ensure projector is loadable; if missing, fall through to bm25
    if (loadProjector()) {
      const hit = distillTop1(text);
      if (hit && Number.isFinite(hit.score)) {
        console.log(
          "phraseDistill pick",
          "score=",
          hit.score.toFixed(3),
          "idx=",
          hit.idx,
          "text=",
          text.slice(0, 40),
        );
        return hit.phrase;
      }
    }
    console.warn("distill unavailable — bm25 fallback");
  }

  const hit = bm25Top1(text);
  console.log(
    "phraseBm25 pick",
    "score=",
    hit.score.toFixed(3),
    "idx=",
    hit.idx,
    "text=",
    text.slice(0, 40),
  );
  return hit.phrase;
}

/** @deprecated runtime no longer loads Xenova; kept for scripts re-exports */
export async function getExtractor() {
  throw new Error(
    "Xenova is offline-only. Use npm run phrases:embed / phrases:train",
  );
}

export async function embedText() {
  throw new Error(
    "Xenova is offline-only. Use npm run phrases:embed / phrases:train",
  );
}
