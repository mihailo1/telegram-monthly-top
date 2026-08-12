/**
 * Remember last Members browser messages so we can delete album previews on nav.
 */
import fs from "node:fs";
import path from "node:path";

const LOCAL_DIR = path.resolve("./data/members/browser");
const BLOB_PREFIX = "members/browser/";

function useRemote() {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN ||
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN,
  );
}

/**
 * @typedef {object} BrowserSession
 * @property {number[]} albumMessageIds
 * @property {number} [controlMessageId]
 * @property {number} index
 */

/** @param {string|number} adminId */
function key(adminId) {
  return String(adminId);
}

/** @param {string|number} adminId */
export async function loadBrowserSession(adminId) {
  const k = key(adminId);
  if (useRemote()) {
    try {
      const { list } = await import("../storage/blob.js");
      const pathname = `${BLOB_PREFIX}${k}.json`;
      const result = await list({ prefix: pathname });
      const blob = result.blobs.find((b) => b.pathname === pathname);
      if (!blob) return null;
      const { getJson } = await import("../storage/blob.js");
      return await getJson(blob.pathname);
    } catch {
      return null;
    }
  }
  const p = path.join(LOCAL_DIR, `${k}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * @param {string|number} adminId
 * @param {BrowserSession} session
 */
export async function saveBrowserSession(adminId, session) {
  const k = key(adminId);
  const body = JSON.stringify(session);
  if (useRemote()) {
    const { put } = await import("../storage/blob.js");
    await put(`${BLOB_PREFIX}${k}.json`, body, {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return;
  }
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOCAL_DIR, `${k}.json`), body, "utf8");
}

/**
 * @param {import('grammy').Api} api
 * @param {string|number} chatId
 * @param {string|number} adminId
 * @param {number[]} [extraMessageIds] also delete these (e.g. clicked control msg)
 */
export async function clearBrowserPreview(
  api,
  chatId,
  adminId,
  extraMessageIds = [],
) {
  const session = await loadBrowserSession(adminId);
  const ids = new Set([
    ...(session?.albumMessageIds || []),
    ...(session?.controlMessageId ? [session.controlMessageId] : []),
    ...extraMessageIds.filter(Boolean),
  ]);
  for (const mid of ids) {
    try {
      await api.deleteMessage(chatId, mid);
    } catch {
      /* ignore */
    }
  }
  await saveBrowserSession(adminId, {
    albumMessageIds: [],
    controlMessageId: 0,
    index: session?.index ?? 0,
  });
}
