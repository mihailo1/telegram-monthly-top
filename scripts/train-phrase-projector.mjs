/**
 * Distill a tiny query encoder: hashed n-grams → e5-small space.
 *
 * Teacher: Xenova multilingual-e5-small (local, offline)
 * Student: linear map HASH_DIM → 384 (runtime = matmul only)
 *
 * Usage:
 *   npm run phrases:embed   # once, if embeddings missing
 *   npm run phrases:train   # can run long; increase EPOCHS / AUGMENTS
 *
 * Env knobs:
 *   EPOCHS=40
 *   AUGMENTS=24          # synthetic queries per phrase
 *   LR=0.05
 *   L2=1e-4
 *   BATCH=64
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HASH_DIM, hashEmbed, normalizeRu, tokenize } from "../src/phraseFeatures.js";
import { EMBEDDINGS_PATH } from "../src/phraseEmbed.js";
import { PROJECTOR_PATH } from "../src/phraseDistill.js";
import { loadReplyPhrases } from "../src/replyPhrases.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EPOCHS = Number(process.env.EPOCHS || 40);
const AUGMENTS = Number(process.env.AUGMENTS || 24);
const LR = Number(process.env.LR || 0.05);
const L2 = Number(process.env.L2 || 1e-4);
const BATCH = Number(process.env.BATCH || 64);
const TEACHER = "Xenova/multilingual-e5-small";

function needEmbeddings() {
  if (!fs.existsSync(EMBEDDINGS_PATH)) {
    console.error("Missing", EMBEDDINGS_PATH, "— run: npm run phrases:embed");
    process.exit(1);
  }
}

/** @param {string} text */
function dropWords(text, rate = 0.3) {
  const toks = normalizeRu(text).split(" ").filter(Boolean);
  if (toks.length <= 1) return text;
  const kept = toks.filter(() => Math.random() > rate);
  return (kept.length ? kept : toks.slice(0, 1)).join(" ");
}

/** @param {string} text */
function shuffleWords(text) {
  const toks = normalizeRu(text).split(" ").filter(Boolean);
  if (toks.length <= 2) return text;
  for (let i = toks.length - 1; i > 0; i--) {
    if (Math.random() > 0.5) continue;
    const j = Math.floor(Math.random() * (i + 1));
    [toks[i], toks[j]] = [toks[j], toks[i]];
  }
  return toks.join(" ");
}

/** @param {string} text */
function prefixSnippet(text) {
  const toks = tokenize(text);
  if (toks.length <= 2) return text;
  const n = 1 + Math.floor(Math.random() * Math.min(3, toks.length));
  return toks.slice(0, n).join(" ");
}

/** Nearby-key typos for RU (approx) */
const NEIGHBOR = {
  й: "цф",
  ц: "йувы",
  у: "цквыа",
  к: "уевпа",
  е: "капро",
  н: "гшо",
  г: "ншрл",
  ш: "гщод",
  щ: "шз",
  з: "щх",
  х: "зъ",
  ф: "яыц",
  ы: "фвца",
  в: "ыаци",
  а: "впрк",
  п: "аро",
  р: "полен",
  о: "рлд",
  л: "одшб",
  д: "лжш",
  ж: "дэ",
  я: "чф",
  ч: "яс",
  с: "чм",
  м: "си",
  и: "мт",
  т: "иь",
};

/** @param {string} text */
function typo(text) {
  const chars = [...normalizeRu(text)];
  if (chars.length < 3) return text;
  const i = 1 + Math.floor(Math.random() * (chars.length - 2));
  const c = chars[i];
  const opts = NEIGHBOR[c];
  if (!opts) return text;
  chars[i] = opts[Math.floor(Math.random() * opts.length)];
  return chars.join(" ");
}

/**
 * @param {string} phrase
 * @param {number} n
 */
function augmentQueries(phrase, n) {
  /** @type {string[]} */
  const out = [phrase, normalizeRu(phrase)];
  const gens = [dropWords, shuffleWords, prefixSnippet, typo];
  while (out.length < n) {
    const g = gens[Math.floor(Math.random() * gens.length)];
    const q = g(phrase);
    if (q && q.trim()) out.push(q);
  }
  return out.slice(0, n);
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / ((Math.sqrt(na) || 1) * (Math.sqrt(nb) || 1));
}

needEmbeddings();
const e5 = JSON.parse(fs.readFileSync(EMBEDDINGS_PATH, "utf8"));
const phrases = loadReplyPhrases();
if (phrases.length !== e5.phrases.length) {
  console.warn("Phrase count mismatch vs embeddings — re-run phrases:embed");
}

const outDim = e5.dim;
console.log({
  phrases: phrases.length,
  hashDim: HASH_DIM,
  outDim,
  EPOCHS,
  AUGMENTS,
  LR,
  L2,
  BATCH,
});

// Teacher for extra query variants (short captions → same passage vector)
console.log("Loading teacher", TEACHER, "…");
const { pipeline, env } = await import("@xenova/transformers");
env.cacheDir =
  process.env.TRANSFORMERS_CACHE ||
  path.join(__dirname, "..", ".transformers-cache");
const extractor = await pipeline("feature-extraction", TEACHER, {
  quantized: true,
});

async function embedQuery(text) {
  const out = await extractor(`query: ${text}`, {
    pooling: "mean",
    normalize: true,
  });
  return Array.from(out.data, Number);
}

/** Build training set: query text → target e5 vector (passage of phrase) */
/** @type {{ x: Float64Array, y: number[] }[]} */
const samples = [];
for (let i = 0; i < phrases.length; i++) {
  const target = e5.vectors[i];
  const queries = augmentQueries(phrases[i], AUGMENTS);
  for (const q of queries) {
    samples.push({ x: hashEmbed(q, HASH_DIM), y: target });
  }
  if ((i + 1) % 30 === 0) console.log(`  aug phrases ${i + 1}/${phrases.length}`);
}

// Also add teacher-query embeddings for a subset of short queries (better alignment)
console.log("Teacher-labeling short queries…");
const extra = Math.min(phrases.length * 4, 600);
for (let k = 0; k < extra; k++) {
  const i = k % phrases.length;
  const q = prefixSnippet(phrases[i]);
  try {
    const y = await embedQuery(q);
    samples.push({ x: hashEmbed(q, HASH_DIM), y });
  } catch {
    /* skip */
  }
  if ((k + 1) % 100 === 0) console.log(`  teacher queries ${k + 1}/${extra}`);
}

console.log("Samples:", samples.length);

// Student: W[hashDim * outDim] row-major, bias[outDim]
const W = new Float64Array(HASH_DIM * outDim);
const bias = new Float64Array(outDim);
// small random init
for (let i = 0; i < W.length; i++) W[i] = (Math.random() - 0.5) * 0.01;

function predict(x, out) {
  for (let d = 0; d < outDim; d++) out[d] = bias[d];
  for (let i = 0; i < HASH_DIM; i++) {
    const xv = x[i];
    if (!xv) continue;
    const row = i * outDim;
    for (let d = 0; d < outDim; d++) out[d] += xv * W[row + d];
  }
  let norm = 0;
  for (let d = 0; d < outDim; d++) norm += out[d] * out[d];
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < outDim; d++) out[d] /= norm;
}

const pred = new Float64Array(outDim);
let bestAvg = -Infinity;
let bestW = null;
let bestBias = null;

for (let epoch = 1; epoch <= EPOCHS; epoch++) {
  // shuffle
  for (let i = samples.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [samples[i], samples[j]] = [samples[j], samples[i]];
  }

  let lossSum = 0;
  for (let start = 0; start < samples.length; start += BATCH) {
    const end = Math.min(start + BATCH, samples.length);
    // accumulate grads
    const gW = new Float64Array(W.length);
    const gB = new Float64Array(outDim);
    for (let s = start; s < end; s++) {
      const { x, y } = samples[s];
      predict(x, pred);
      // MSE on normalized vectors
      for (let d = 0; d < outDim; d++) {
        const diff = pred[d] - y[d];
        lossSum += diff * diff;
        gB[d] += (2 * diff) / (end - start);
        // d(pred)/dW approx without renorm for speed
        for (let i = 0; i < HASH_DIM; i++) {
          const xv = x[i];
          if (!xv) continue;
          gW[i * outDim + d] += ((2 * diff) / (end - start)) * xv;
        }
      }
    }
    // SGD + L2
    for (let i = 0; i < W.length; i++) {
      W[i] -= LR * (gW[i] + L2 * W[i]);
    }
    for (let d = 0; d < outDim; d++) {
      bias[d] -= LR * (gB[d] + L2 * bias[d]);
    }
  }

  // eval: mean cosine phrase→self via student
  let cosSum = 0;
  for (let i = 0; i < phrases.length; i++) {
    predict(hashEmbed(phrases[i], HASH_DIM), pred);
    cosSum += cosine(pred, e5.vectors[i]);
  }
  const avg = cosSum / phrases.length;
  const mse = lossSum / (samples.length * outDim);
  console.log(
    `epoch ${epoch}/${EPOCHS}  mse=${mse.toFixed(5)}  selfCos=${avg.toFixed(4)}`,
  );
  if (avg > bestAvg) {
    bestAvg = avg;
    bestW = Float64Array.from(W);
    bestBias = Float64Array.from(bias);
  }
}

const Wout = bestW || W;
const Bout = bestBias || bias;

// Holdout-ish check with BM25-style short queries
let hit1 = 0;
const trials = Math.min(phrases.length, 80);
for (let i = 0; i < trials; i++) {
  const q = prefixSnippet(phrases[i]);
  predict(hashEmbed(q, HASH_DIM), pred);
  let best = 0;
  let bestS = -Infinity;
  for (let j = 0; j < e5.vectors.length; j++) {
    const s = cosine(pred, e5.vectors[j]);
    if (s > bestS) {
      bestS = s;
      best = j;
    }
  }
  if (best === i) hit1 += 1;
}
console.log(
  `short-query top1 recall@self: ${hit1}/${trials} (${((100 * hit1) / trials).toFixed(1)}%)`,
);
console.log(`best selfCos during train: ${bestAvg.toFixed(4)}`);

const dataDir = path.join(__dirname, "..", "src", "data");
fs.mkdirSync(dataDir, { recursive: true });
const binPath = path.join(dataDir, "phrase-query-projector.bin");
const metaPath = path.join(dataDir, "phrase-query-projector.meta.json");

const biasF32 = Float32Array.from(Bout);
const WF32 = Float32Array.from(Wout);
const buf = Buffer.alloc(biasF32.byteLength + WF32.byteLength);
Buffer.from(biasF32.buffer).copy(buf, 0);
Buffer.from(WF32.buffer).copy(buf, biasF32.byteLength);
fs.writeFileSync(binPath, buf);

const meta = {
  teacherModel: TEACHER,
  hashDim: HASH_DIM,
  outDim,
  layout: "bin-bias-then-W-f32",
  bin: "phrase-query-projector.bin",
  trainedAt: new Date().toISOString(),
  epochs: EPOCHS,
  augments: AUGMENTS,
  samples: samples.length,
  selfCos: bestAvg,
};
fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
// remove legacy fat JSON if present
try {
  fs.unlinkSync(path.join(dataDir, "phrase-query-projector.json"));
} catch {
  /* ignore */
}
console.log(
  "Wrote",
  metaPath,
  "+ bin",
  `${(fs.statSync(binPath).size / 1024 / 1024).toFixed(2)} MB`,
);
console.log("Runtime default: PHRASE_PICKER=distill when meta+bin+e5 exist.");
