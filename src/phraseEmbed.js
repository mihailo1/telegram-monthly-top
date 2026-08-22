/**
 * Local semantic phrase picker via @xenova/transformers (multilingual-e5-small).
 * Phrase vectors are precomputed (src/data/reply-phrase-embeddings.json);
 * at runtime we only embed the user text and take cosine top-1.
 *
 * Env:
 *   PHRASE_PICKER=embed|random  (default: embed if embeddings file exists)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadReplyPhrases, randomReplyPhrase } from "./replyPhrases.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EMBED_MODEL = "Xenova/multilingual-e5-small";
export const EMBEDDINGS_PATH = path.join(
  __dirname,
  "data",
  "reply-phrase-embeddings.json",
);

/** @type {import('@xenova/transformers').FeatureExtractionPipeline | null} */
let extractor = null;
/** @type {{ model: string, dim: number, phrases: string[], vectors: number[][] } | null} */
let phraseIndex = null;
/** @type {Promise<import('@xenova/transformers').FeatureExtractionPipeline> | null} */
let loading = null;

function pickerMode() {
  const m = (process.env.PHRASE_PICKER || "").toLowerCase().trim();
  if (m === "random" || m === "embed") return m;
  // default: use embed when index file is present
  return fs.existsSync(EMBEDDINGS_PATH) ? "embed" : "random";
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function meanPool(output, attentionMask) {
  // output: Tensor [1, seq, dim] or nested arrays
  const data = output.data || output;
  const dims = output.dims || null;
  if (dims && dims.length === 3) {
    const [, seq, dim] = dims;
    const mask = attentionMask?.data || attentionMask;
    const out = new Array(dim).fill(0);
    let count = 0;
    for (let s = 0; s < seq; s++) {
      const m = mask ? Number(mask[s]) : 1;
      if (!m) continue;
      count += 1;
      for (let d = 0; d < dim; d++) {
        out[d] += data[s * dim + d];
      }
    }
    if (!count) count = 1;
    for (let d = 0; d < dim; d++) out[d] /= count;
    // L2 normalize (e5 style)
    let norm = 0;
    for (let d = 0; d < dim; d++) norm += out[d] * out[d];
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dim; d++) out[d] /= norm;
    return out;
  }
  // fallback: already pooled vector
  if (Array.isArray(data)) {
    const flat = Array.isArray(data[0]) ? data[0] : data;
    const out = Array.from(flat, Number);
    let norm = 0;
    for (const x of out) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    return out.map((x) => x / norm);
  }
  return Array.from(data);
}

export async function getExtractor() {
  if (extractor) return extractor;
  if (loading) return loading;
  loading = (async () => {
    const { pipeline, env } = await import("@xenova/transformers");
    // Cache under /tmp on serverless; allow remote model download on first cold start
    env.cacheDir = process.env.TRANSFORMERS_CACHE || "/tmp/transformers-cache";
    env.allowLocalModels = false;
    extractor = await pipeline("feature-extraction", EMBED_MODEL, {
      quantized: true,
    });
    return extractor;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

/**
 * @param {string} text
 * @param {"query"|"passage"} role
 */
export async function embedText(text, role = "query") {
  const pipe = await getExtractor();
  const prefixed =
    role === "query" ? `query: ${text}` : `passage: ${text}`;
  const out = await pipe(prefixed, {
    pooling: "mean",
    normalize: true,
  });
  // transformers.js v2 often returns Tensor with .data
  if (out?.data) {
    return Array.from(out.data, Number);
  }
  if (Array.isArray(out)) {
    const row = Array.isArray(out[0]) ? out[0] : out;
    return row.map(Number);
  }
  return meanPool(out);
}

export function loadPhraseIndex() {
  if (phraseIndex) return phraseIndex;
  if (!fs.existsSync(EMBEDDINGS_PATH)) return null;
  try {
    phraseIndex = JSON.parse(fs.readFileSync(EMBEDDINGS_PATH, "utf8"));
    return phraseIndex;
  } catch (err) {
    console.error("loadPhraseIndex failed", err.message);
    return null;
  }
}

/**
 * Pick best phrase for user text; falls back to random.
 * @param {string} [userText]
 * @returns {Promise<string>}
 */
export async function pickReplyPhrase(userText) {
  const text = (userText || "").trim();
  if (!text || pickerMode() === "random") {
    return randomReplyPhrase();
  }

  const index = loadPhraseIndex();
  if (!index?.vectors?.length || !index?.phrases?.length) {
    console.warn("phrase embeddings missing — random fallback");
    return randomReplyPhrase();
  }

  try {
    const q = await embedText(text, "query");
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < index.vectors.length; i++) {
      const s = cosine(q, index.vectors[i]);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    const phrase = index.phrases[best] || randomReplyPhrase();
    console.log(
      "phraseEmbed pick",
      "score=",
      bestScore.toFixed(3),
      "idx=",
      best,
      "text=",
      text.slice(0, 40),
    );
    return phrase;
  } catch (err) {
    console.warn("phraseEmbed failed, random fallback", err?.message || err);
    return randomReplyPhrase();
  }
}

/** Ensure phrases in index match current corpus length (sanity). */
export function embeddingsStale() {
  const index = loadPhraseIndex();
  if (!index) return true;
  const live = loadReplyPhrases();
  return index.phrases?.length !== live.length || index.model !== EMBED_MODEL;
}
