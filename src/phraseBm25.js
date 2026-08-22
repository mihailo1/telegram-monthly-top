/**
 * BM25 over reply phrases — zero neural net, tiny CPU.
 */
import { loadReplyPhrases, randomReplyPhrase } from "./replyPhrases.js";
import { tokenize } from "./phraseFeatures.js";

const K1 = 1.4;
const B = 0.75;

/** @type {{ phrases: string[], docs: string[][], df: Map<string, number>, avgdl: number } | null} */
let index = null;

function buildIndex() {
  const phrases = loadReplyPhrases();
  const docs = phrases.map((p) => tokenize(p));
  /** @type {Map<string, number>} */
  const df = new Map();
  let totalLen = 0;
  for (const doc of docs) {
    totalLen += doc.length;
    const seen = new Set(doc);
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
  }
  index = {
    phrases,
    docs,
    df,
    avgdl: docs.length ? totalLen / docs.length : 1,
  };
  return index;
}

function getIndex() {
  return index || buildIndex();
}

/**
 * @param {string} query
 * @returns {{ phrase: string, score: number, idx: number }}
 */
export function bm25Top1(query) {
  const qTokens = tokenize(query);
  if (!qTokens.length) {
    const phrase = randomReplyPhrase();
    return { phrase, score: 0, idx: -1 };
  }
  const { phrases, docs, df, avgdl } = getIndex();
  const N = docs.length;
  /** @type {Map<string, number>} */
  const qtf = new Map();
  for (const t of qTokens) qtf.set(t, (qtf.get(t) || 0) + 1);

  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const dl = doc.length || 1;
    /** @type {Map<string, number>} */
    const tfs = new Map();
    for (const t of doc) tfs.set(t, (tfs.get(t) || 0) + 1);

    let score = 0;
    for (const [t, qf] of qtf) {
      const f = tfs.get(t) || 0;
      if (!f) continue;
      const n = df.get(t) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const tfPart =
        (f * (K1 + 1)) / (f + K1 * (1 - B + (B * dl) / avgdl));
      score += idf * tfPart * (1 + Math.log(qf));
    }
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (!Number.isFinite(bestScore) || bestScore <= 0) {
    return { phrase: randomReplyPhrase(), score: 0, idx: -1 };
  }
  return { phrase: phrases[best], score: bestScore, idx: best };
}
