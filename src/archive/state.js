/**
 * Persistent state for the Sunday archive post: which photos and themes were
 * already used, and per-day drafts. Stored through storage/blob.js.
 */
import fs from "node:fs";
import path from "node:path";
import { getJson, put as storePut } from "../storage/blob.js";

const STATE_KEY = "archive/state.json";
const draftKey = (id) => `archive/drafts/${id}.json`;
const LOCAL_ROOT = path.resolve("./data/archive");
const MAX_USED = 2000;
const MAX_RECENT_THEMES = 8;

function useRemote() {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN ||
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN,
  );
}

async function readJson(key) {
  try {
    if (useRemote()) return await getJson(key);
    return JSON.parse(fs.readFileSync(path.join(LOCAL_ROOT, key), "utf8"));
  } catch {
    return null;
  }
}

/** @param {{ allowOverwrite?: boolean }} [opts] */
async function writeJson(key, value, opts = {}) {
  const body = JSON.stringify(value, null, 2);
  if (useRemote()) {
    await storePut(key, body, {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: opts.allowOverwrite !== false,
    });
    return;
  }
  const file = path.join(LOCAL_ROOT, key);
  if (opts.allowOverwrite === false && fs.existsSync(file)) {
    const err = new Error("file exists");
    err.statusCode = 409;
    throw err;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

/** @returns {Promise<{ usedIds: string[], recentThemes: string[] }>} */
export async function loadArchiveState() {
  const s = await readJson(STATE_KEY);
  return {
    usedIds: Array.isArray(s?.usedIds) ? s.usedIds : [],
    recentThemes: Array.isArray(s?.recentThemes) ? s.recentThemes : [],
  };
}

/** Remember a posted set so it is not repeated. */
export async function recordArchivePost(themeKey, photoIds) {
  const s = await loadArchiveState();
  s.usedIds = [...s.usedIds, ...photoIds].slice(-MAX_USED);
  s.recentThemes = [...s.recentThemes, themeKey].slice(-MAX_RECENT_THEMES);
  await writeJson(STATE_KEY, s);
}

export async function loadDraft(id) {
  return readJson(draftKey(id));
}

export async function saveDraft(draft) {
  await writeJson(draftKey(draft.id), draft);
}

/**
 * Create a draft only if none exists with this id (race guard between
 * overlapping cron ticks). Returns false if someone else created it first.
 */
export async function createDraftOnce(draft) {
  if (await loadDraft(draft.id)) return false;
  try {
    await writeJson(draftKey(draft.id), draft, { allowOverwrite: false });
    return true;
  } catch (err) {
    if (err.statusCode === 409 || /exists|already/i.test(err.message)) {
      return false;
    }
    throw err;
  }
}

const AWAITING_KEY = "archive/awaiting.json";

/** The admin's next plain text message becomes this draft's caption. */
export async function setAwaiting(draftId) {
  await writeJson(AWAITING_KEY, { draftId, at: new Date().toISOString() });
}

/** @returns {Promise<{ draftId: string, at: string } | null>} */
export async function getAwaiting() {
  const a = await readJson(AWAITING_KEY);
  return a?.draftId ? a : null;
}

export async function clearAwaiting() {
  await writeJson(AWAITING_KEY, {});
}
