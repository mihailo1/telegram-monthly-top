/**
 * Tiny distilled query encoder: hashed n-grams → 384-d ≈ e5 space.
 * Trained offline (scripts/train-phrase-projector.mjs); runtime = matmul only.
 *
 * Artifacts:
 *   src/data/phrase-query-projector.meta.json
 *   src/data/phrase-query-projector.bin  (bias then W, float32 LE)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HASH_DIM, hashEmbed } from "./phraseFeatures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECTOR_META_PATH = path.join(
  __dirname,
  "data",
  "phrase-query-projector.meta.json",
);
export const PROJECTOR_PATH = PROJECTOR_META_PATH; // alias for existence checks

/**
 * @typedef {object} ProjectorRuntime
 * @property {number} hashDim
 * @property {number} outDim
 * @property {Float32Array} bias
 * @property {Float32Array} W
 */

/** @type {ProjectorRuntime | null} */
let projector = null;
/** @type {{ phrases: string[], vectors: number[][], dim: number } | null} */
let phraseE5 = null;

export function loadProjector() {
  if (projector) return projector;
  if (!fs.existsSync(PROJECTOR_META_PATH)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(PROJECTOR_META_PATH, "utf8"));
    const binName = meta.bin || "phrase-query-projector.bin";
    const binPath = path.join(__dirname, "data", binName);
    if (!fs.existsSync(binPath)) {
      console.error("projector bin missing", binPath);
      return null;
    }
    const buf = fs.readFileSync(binPath);
    const outDim = meta.outDim;
    const hashDim = meta.hashDim || HASH_DIM;
    const biasBytes = outDim * 4;
    const bias = new Float32Array(
      buf.buffer,
      buf.byteOffset,
      outDim,
    );
    const W = new Float32Array(
      buf.buffer,
      buf.byteOffset + biasBytes,
      hashDim * outDim,
    );
    // copy — Buffer pool may be reused
    projector = {
      hashDim,
      outDim,
      bias: Float32Array.from(bias),
      W: Float32Array.from(W),
    };
    return projector;
  } catch (err) {
    console.error("loadProjector failed", err.message);
    return null;
  }
}

export function loadPhraseE5() {
  if (phraseE5) return phraseE5;
  const p = path.join(__dirname, "data", "reply-phrase-embeddings.json");
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    phraseE5 = {
      phrases: raw.phrases,
      vectors: raw.vectors,
      dim: raw.dim,
    };
    return phraseE5;
  } catch (err) {
    console.error("loadPhraseE5 failed", err.message);
    return null;
  }
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

/**
 * @param {string} text
 * @returns {Float64Array | null}
 */
export function projectQuery(text) {
  const P = loadProjector();
  if (!P) return null;
  const x = hashEmbed(text, P.hashDim);
  const out = new Float64Array(P.outDim);
  for (let d = 0; d < P.outDim; d++) out[d] = P.bias[d];
  for (let i = 0; i < P.hashDim; i++) {
    const xv = x[i];
    if (!xv) continue;
    const row = i * P.outDim;
    for (let d = 0; d < P.outDim; d++) out[d] += xv * P.W[row + d];
  }
  let norm = 0;
  for (let d = 0; d < P.outDim; d++) norm += out[d] * out[d];
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < P.outDim; d++) out[d] /= norm;
  return out;
}

/**
 * @param {string} userText
 * @returns {{ phrase: string, score: number, idx: number } | null}
 */
export function distillTop1(userText) {
  const e5 = loadPhraseE5();
  const q = projectQuery(userText);
  if (!e5 || !q) return null;

  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < e5.vectors.length; i++) {
    const s = cosine(q, e5.vectors[i]);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return {
    phrase: e5.phrases[best],
    score: bestScore,
    idx: best,
  };
}
