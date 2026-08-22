/**
 * Lightweight text features for phrase matching (no neural net at runtime).
 * - tokenize Russian-ish text
 * - word uni/bi-grams + char 3–5 grams
 * - signed feature hashing into fixed dim
 */

const HASH_DIM = 4096;

/** @param {string} s */
export function normalizeRu(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9\s]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Very light RU stem: peel common endings (lossy but fine for BM25/hash). */
export function lightStem(token) {
  if (token.length < 5) return token;
  const endings = [
    "иями",
    "ями",
    "ами",
    "ией",
    "оям",
    "ием",
    "иях",
    "ях",
    "ом",
    "ем",
    "ой",
    "ей",
    "ию",
    "ью",
    "ия",
    "ья",
    "ие",
    "ые",
    "ий",
    "ый",
    "ое",
    "ая",
    "яя",
    "ов",
    "ев",
    "ам",
    "ям",
    "ах",
    "ях",
    "ть",
    "ти",
    "ла",
    "ли",
    "ло",
    "ет",
    "ут",
    "ют",
    "ит",
    "ат",
    "ят",
  ];
  for (const e of endings) {
    if (token.endsWith(e) && token.length - e.length >= 3) {
      return token.slice(0, -e.length);
    }
  }
  return token;
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const n = normalizeRu(text);
  if (!n) return [];
  return n
    .split(" ")
    .filter(Boolean)
    .map(lightStem);
}

/**
 * FNV-1a 32-bit
 * @param {string} str
 */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * @param {string} text
 * @returns {Map<string, number>} term → tf
 */
export function termFreqs(text) {
  /** @type {Map<string, number>} */
  const tf = new Map();
  const bump = (t) => tf.set(t, (tf.get(t) || 0) + 1);

  const tokens = tokenize(text);
  for (const t of tokens) bump(`w:${t}`);
  for (let i = 0; i < tokens.length - 1; i++) {
    bump(`b:${tokens[i]}_${tokens[i + 1]}`);
  }

  const compact = normalizeRu(text).replace(/\s+/g, "");
  for (let n = 3; n <= 5; n++) {
    for (let i = 0; i <= compact.length - n; i++) {
      bump(`c${n}:${compact.slice(i, i + n)}`);
    }
  }
  return tf;
}

/**
 * Signed hashed bag → dense Float64Array length HASH_DIM
 * @param {string} text
 * @param {number} [dim]
 */
export function hashEmbed(text, dim = HASH_DIM) {
  const vec = new Float64Array(dim);
  const tf = termFreqs(text);
  if (!tf.size) return vec;
  for (const [term, count] of tf) {
    const h = fnv1a(term);
    const idx = h % dim;
    const sign = h & 0x80000000 ? -1 : 1;
    // log tf
    vec[idx] += sign * (1 + Math.log(count));
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

export { HASH_DIM };
