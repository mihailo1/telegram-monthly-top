/**
 * Debounce author replies: one reply per author/topic per 60s.
 * Prefer candidates that carry text/caption.
 */
import { getJson, list as storeList, put as storePut } from "../storage/blob.js";
import fs from "node:fs";
import path from "node:path";

const WINDOW_MS = 60 * 1000;
const SETTLE_MS = 2500;
const LOCAL_DIR = path.resolve("./data/members/phrase-debounce");
const BLOB_PREFIX = "members/phrase-debounce/";

/** @type {Map<string, { timer?: NodeJS.Timeout, best: object, resolve?: Function }>} */
const pending = new Map();

function useRemote() {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN ||
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN,
  );
}

function debounceKey(opts) {
  const topic = opts.directMessagesTopicId ?? opts.messageThreadId ?? "";
  const user = opts.fromUserId || "";
  const chat = opts.replyChatId || "";
  return `${chat}|${topic}|${user}`;
}

function scoreCandidate(c) {
  const text = (c.text || c.caption || "").trim();
  return text ? 2 : 1;
}

async function loadLastSent(key) {
  const pathname = `${BLOB_PREFIX}${encodeURIComponent(key)}.json`;
  if (useRemote()) {
    try {
      const result = await storeList({ prefix: pathname });
      if (!result.blobs.some((b) => b.pathname === pathname)) return 0;
      const j = await getJson(pathname);
      return j?.at || 0;
    } catch {
      return 0;
    }
  }
  const p = path.join(LOCAL_DIR, `${encodeURIComponent(key)}.json`);
  if (!fs.existsSync(p)) return 0;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")).at || 0;
  } catch {
    return 0;
  }
}

async function saveLastSent(key) {
  const body = JSON.stringify({ at: Date.now() });
  const pathname = `${BLOB_PREFIX}${encodeURIComponent(key)}.json`;
  if (useRemote()) {
    await storePut(pathname, body, {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return;
  }
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(LOCAL_DIR, `${encodeURIComponent(key)}.json`),
    body,
    "utf8",
  );
}

/**
 * Schedule a debounced author reply. Returns immediately; fires once after settle.
 * @param {object} candidate
 * @param {(best: object) => Promise<void>} sendFn
 * @returns {Promise<"scheduled"|"suppressed"|"skipped_recent">}
 */
export async function scheduleDebouncedReply(candidate, sendFn) {
  const key = debounceKey(candidate);
  const last = await loadLastSent(key);
  if (Date.now() - last < WINDOW_MS) {
    // Still accept better (text) candidate into a pending slot if one is open
    const cur = pending.get(key);
    if (cur && scoreCandidate(candidate) > scoreCandidate(cur.best)) {
      cur.best = candidate;
    }
    return "skipped_recent";
  }

  let slot = pending.get(key);
  if (!slot) {
    slot = { best: candidate };
    pending.set(key, slot);
    slot.timer = setTimeout(async () => {
      const best = pending.get(key)?.best;
      pending.delete(key);
      if (!best) return;
      const last2 = await loadLastSent(key);
      if (Date.now() - last2 < WINDOW_MS) return;
      try {
        await sendFn(best);
        await saveLastSent(key);
      } catch (err) {
        console.warn("debounced reply failed", err?.message || err);
      }
    }, SETTLE_MS);
    // Prevent serverless freeze if waitUntil available
    try {
      const { waitUntil } = await import("@vercel/functions");
      if (typeof waitUntil === "function" && slot.timer) {
        waitUntil(
          new Promise((r) => setTimeout(r, SETTLE_MS + 500)),
        );
      }
    } catch {
      /* ignore */
    }
    return "scheduled";
  }

  if (scoreCandidate(candidate) >= scoreCandidate(slot.best)) {
    slot.best = candidate;
  }
  return "suppressed";
}

export { WINDOW_MS as PHRASE_DEBOUNCE_MS, SETTLE_MS as PHRASE_SETTLE_MS };
