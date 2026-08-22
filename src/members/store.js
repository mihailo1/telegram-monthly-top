/**
 * Members (UGC) queue — posts from channel Direct Messages.
 * One item = one user message (1 media or album 2–10) + optional caption.
 */
import fs from "node:fs";
import path from "node:path";
import {
  del as storeDel,
  getJson,
  list as storeList,
  put as storePut,
} from "../storage/blob.js";

const LOCAL_DIR = path.resolve("./data/members/items");
const BLOB_PREFIX = "members/items/";
const SEEN_PREFIX = "members/seen/";

/**
 * @typedef {"photo"|"video"} MediaType
 * @typedef {"queued"|"scheduled"|"posted"|"cancelled"|"rejected"} MemberStatus
 *
 * @typedef {object} MemberMedia
 * @property {string} fileId
 * @property {MediaType} mediaType
 *
 * @typedef {object} MemberItem
 * @property {string} id
 * @property {MemberMedia[]} media
 * @property {string} [caption]
 * @property {string} [fromUserId]
 * @property {string} [fromUsername]
 * @property {string} [sourceKey]  monoforum msg key for dedupe
 * @property {string|number} [sourceChatId]  DM/monoforum chat for forwardMessage
 * @property {number[]} [sourceMessageIds]  original message ids (album = many)
 * @property {number} [directMessagesTopicId]
 * @property {string} addedAt
 * @property {MemberStatus} status
 * @property {string} [postAt]
 * @property {string} [postDay]
 * @property {boolean} [authorNotified]
 * @property {number} [postedMessageId]
 * @property {string} [postedAt]
 */

function useRemote() {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN ||
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN,
  );
}

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** @param {MemberItem} item */
async function writeItem(item) {
  const body = JSON.stringify(item);
  if (useRemote()) {
    await storePut(`${BLOB_PREFIX}${item.id}.json`, body, {
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

async function listItems() {
  if (useRemote()) {
    try {
      const result = await storeList({ prefix: BLOB_PREFIX });
      const items = [];
      for (const blob of result.blobs) {
        if (!blob.pathname.endsWith(".json")) continue;
        try {
          const item = await getJson(blob.pathname);
          if (item?.id && item?.media?.length) items.push(item);
        } catch {
          /* skip */
        }
      }
      return items;
    } catch (err) {
      console.error("members listItems", err.message);
      return [];
    }
  }
  if (!fs.existsSync(LOCAL_DIR)) return [];
  return fs
    .readdirSync(LOCAL_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(LOCAL_DIR, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function sortItems(items) {
  return [...items].sort((a, b) => {
    if (a.addedAt !== b.addedAt) return a.addedAt < b.addedAt ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

export async function loadMembersQueue() {
  const items = sortItems(await listItems());
  return { items, updatedAt: new Date().toISOString() };
}

export async function getMemberItem(id) {
  const { items } = await loadMembersQueue();
  return items.find((i) => i.id === id) || null;
}

export async function updateMemberItem(id, patch) {
  const item = await getMemberItem(id);
  if (!item) return null;
  const next = { ...item, ...patch };
  await writeItem(next);
  return next;
}

/**
 * Hard-delete item from store (preferred over status=cancelled for browser freshness).
 * @param {string} id
 */
export async function removeMemberItem(id) {
  if (useRemote()) {
    try {
      const pathname = `${BLOB_PREFIX}${id}.json`;
      const result = await storeList({ prefix: pathname });
      let removed = false;
      for (const blob of result.blobs) {
        if (blob.pathname === pathname) {
          await storeDel(blob.pathname);
          removed = true;
        }
      }
      return removed;
    } catch (err) {
      console.error("removeMemberItem remote", err.message);
      return false;
    }
  }
  const p = path.join(LOCAL_DIR, `${id}.json`);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

export function countMembersActive(items) {
  return items.filter(
    (i) => i.status === "queued" || i.status === "scheduled",
  ).length;
}

export function listMembersActive(items) {
  const scheduled = items.filter((i) => i.status === "scheduled");
  const queued = items.filter((i) => i.status === "queued");
  return [...scheduled, ...queued];
}

export function listMembersQueued(items) {
  return items.filter((i) => i.status === "queued");
}

export function getMembersScheduled(items) {
  return items.find((i) => i.status === "scheduled") || null;
}

/**
 * @param {object} input
 * @param {MemberMedia[]} input.media
 * @param {string} [input.caption]
 * @param {string} [input.fromUserId]
 * @param {string} [input.fromUsername]
 * @param {string} [input.sourceKey]
 * @param {string|number} [input.sourceChatId]
 * @param {number[]} [input.sourceMessageIds]
 * @param {number} [input.directMessagesTopicId]
 */
export async function appendMemberPost(input) {
  if (!input.media?.length || input.media.length > 10) {
    throw new Error("media must be 1–10 items");
  }
  const sourceMessageIds = Array.isArray(input.sourceMessageIds)
    ? input.sourceMessageIds.map(Number).filter((n) => n > 0)
    : [];
  /** @type {MemberItem} */
  const item = {
    id: newId(),
    media: input.media,
    caption: input.caption || "",
    fromUserId: input.fromUserId || "",
    fromUsername: input.fromUsername || "",
    sourceKey: input.sourceKey || "",
    sourceChatId: input.sourceChatId ?? "",
    sourceMessageIds,
    directMessagesTopicId: input.directMessagesTopicId ?? undefined,
    addedAt: new Date().toISOString(),
    status: "queued",
  };
  await writeItem(item);
  return item;
}

/** @param {string} sourceKey */
export async function wasSourceSeen(sourceKey) {
  if (!sourceKey) return false;
  if (useRemote()) {
    try {
      const pathname = `${SEEN_PREFIX}${sourceKey}.json`;
      const result = await storeList({ prefix: pathname });
      return result.blobs.some((b) => b.pathname === pathname);
    } catch {
      return false;
    }
  }
  const p = path.resolve(`./data/members/seen/${sourceKey}.json`);
  return fs.existsSync(p);
}

/** @param {string} sourceKey */
export async function markSourceSeen(sourceKey) {
  if (!sourceKey) return;
  const body = JSON.stringify({ at: new Date().toISOString() });
  if (useRemote()) {
    await storePut(`${SEEN_PREFIX}${sourceKey}.json`, body, {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return;
  }
  const dir = path.resolve("./data/members/seen");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sourceKey}.json`), body, "utf8");
}
