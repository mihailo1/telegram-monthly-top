/**
 * Daily photo queue storage (concurrency-safe for album uploads).
 *
 * Each photo is its own record (Blob object or local file), so parallel
 * webhook invocations for a media group cannot overwrite each other.
 *
 * Local:  data/queue/items/<id>.json
 * Vercel: Blob queue/items/<id>.json
 *
 * Media are Telegram file_ids (bot can re-send them to the channel).
 * mediaType: "photo" | "video" (default photo for older items).
 */
import fs from "node:fs";
import path from "node:path";

const LOCAL_DIR = path.resolve("./data/queue/items");
const BLOB_PREFIX = "queue/items/";

/**
 * @typedef {"queued"|"scheduled"|"posted"|"cancelled"} QueueItemStatus
 * @typedef {"photo"|"video"} MediaType
 *
 * @typedef {object} QueueItem
 * @property {string} id
 * @property {string} fileId
 * @property {MediaType} [mediaType]
 * @property {string} addedAt
 * @property {QueueItemStatus} status
 * @property {string} [postAt]
 * @property {string} [postDay]
 * @property {boolean} [notified]
 * @property {number} [notifyMessageId]
 * @property {number} [postedMessageId]
 * @property {string} [postedAt]
 */

/**
 * @typedef {object} QueueState
 * @property {number} version
 * @property {QueueItem[]} items
 * @property {string} updatedAt
 */

function useBlob() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

/** @returns {QueueState} */
export function emptyQueue() {
  return { version: 2, items: [], updatedAt: new Date().toISOString() };
}

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** @param {QueueItem} item */
async function writeItem(item) {
  const body = JSON.stringify(item);

  if (useBlob()) {
    const { put } = await import("@vercel/blob");
    await put(`${BLOB_PREFIX}${item.id}.json`, body, {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return;
  }

  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOCAL_DIR, `${item.id}.json`), body, "utf8");
}

/** @returns {Promise<QueueItem[]>} */
async function listAllItems() {
  if (useBlob()) {
    try {
      const { list } = await import("@vercel/blob");
      const result = await list({ prefix: BLOB_PREFIX });
      const items = [];
      for (const blob of result.blobs) {
        if (!blob.pathname.endsWith(".json")) continue;
        try {
          const res = await fetch(blob.url, { cache: "no-store" });
          if (!res.ok) continue;
          const item = await res.json();
          if (item?.id && item?.fileId) items.push(item);
        } catch {
          /* skip bad object */
        }
      }
      return items;
    } catch (err) {
      console.error("listAllItems blob:", err.message ?? err);
      return [];
    }
  }

  if (!fs.existsSync(LOCAL_DIR)) return [];
  const files = fs.readdirSync(LOCAL_DIR).filter((f) => f.endsWith(".json"));
  const items = [];
  for (const f of files) {
    try {
      items.push(JSON.parse(fs.readFileSync(path.join(LOCAL_DIR, f), "utf8")));
    } catch {
      /* skip */
    }
  }
  return items;
}

function sortItems(items) {
  return [...items].sort((a, b) => {
    const ta = a.addedAt || "";
    const tb = b.addedAt || "";
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

/** @returns {Promise<QueueState>} */
export async function loadQueue() {
  const items = sortItems(await listAllItems());
  return {
    version: 2,
    items,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * @deprecated kept for callers — rewrites all items (avoid under concurrency)
 * @param {QueueState} state
 */
export async function saveQueue(state) {
  for (const item of state.items) {
    await writeItem(item);
  }
}

/**
 * @param {string[]} fileIds
 * @returns {Promise<{ added: number, totalQueued: number, state: QueueState }>}
 */
export async function appendPhotos(fileIds) {
  return appendMedia(fileIds.map((fileId) => ({ fileId, mediaType: "photo" })));
}

/**
 * @param {{ fileId: string, mediaType?: MediaType }[]} media
 * @returns {Promise<{ added: number, totalQueued: number, state: QueueState }>}
 */
export async function appendMedia(media) {
  const now = new Date().toISOString();
  let added = 0;
  for (const m of media) {
    if (!m?.fileId) continue;
    /** @type {QueueItem} */
    const item = {
      id: newId(),
      fileId: m.fileId,
      mediaType: m.mediaType === "video" ? "video" : "photo",
      addedAt: now,
      status: "queued",
    };
    await writeItem(item);
    added += 1;
  }
  const state = await loadQueue();
  const totalQueued = countActive(state);
  return { added, totalQueued, state };
}

/** @param {QueueItem} item */
export function itemMediaType(item) {
  return item.mediaType === "video" ? "video" : "photo";
}

/** @param {string} id */
export async function getItem(id) {
  const state = await loadQueue();
  return state.items.find((i) => i.id === id) || null;
}

/**
 * @param {string} id
 * @param {Partial<QueueItem>} patch
 */
export async function updateItem(id, patch) {
  const state = await loadQueue();
  const item = state.items.find((i) => i.id === id);
  if (!item) return null;
  const next = { ...item, ...patch };
  await writeItem(next);
  return next;
}

export function countActive(state) {
  return state.items.filter(
    (i) => i.status === "queued" || i.status === "scheduled",
  ).length;
}

export function listQueued(state) {
  return state.items.filter((i) => i.status === "queued");
}

export function getScheduled(state) {
  return state.items.find((i) => i.status === "scheduled") || null;
}

/**
 * Active queue in post order: scheduled first, then queued by addedAt.
 * @param {QueueState} state
 * @returns {QueueItem[]}
 */
export function listActiveInOrder(state) {
  const scheduled = state.items.filter((i) => i.status === "scheduled");
  const queued = state.items
    .filter((i) => i.status === "queued")
    .sort((a, b) => {
      if (a.addedAt !== b.addedAt) return a.addedAt < b.addedAt ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
  return [...scheduled, ...queued];
}
