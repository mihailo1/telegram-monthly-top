/**
 * Persist preview payload for Publish button.
 *
 * Local:  ./data/pending/<id>.json
 * Vercel: @vercel/blob (needs BLOB_READ_WRITE_TOKEN)
 *
 * Photos are stored as Telegram file_id (from the DM preview album),
 * so we never keep image binaries in the store.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const PENDING_ROOT = path.resolve("./data/pending");

/**
 * @typedef {object} PendingMeta
 * @property {string} id
 * @property {string} createdAt
 * @property {"pending"|"published"|"cancelled"} status
 * @property {number} month
 * @property {string} rangeLabel
 * @property {string} pollQuestion
 * @property {string[]} pollOptions
 * @property {boolean} isAnonymous
 * @property {boolean} allowsMultipleAnswers
 * @property {string} channelUsername
 * @property {string} groupChatId
 * @property {{ fileId: string, sourceId: number, score: number, messageLink?: string }[]} photos
 * @property {number} [adminMessageId]
 */

function useBlob() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

/**
 * @param {PendingMeta} meta
 */
export async function savePendingMeta(meta) {
  if (useBlob()) {
    const { put } = await import("@vercel/blob");
    await put(`pending/${meta.id}.json`, JSON.stringify(meta), {
      access: "public", // meta is not secret; file_ids are bound to bot
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return meta;
  }

  fs.mkdirSync(PENDING_ROOT, { recursive: true });
  fs.writeFileSync(
    path.join(PENDING_ROOT, `${meta.id}.json`),
    JSON.stringify(meta, null, 2),
  );
  return meta;
}

/**
 * Create pending from ranked posts + Telegram file_ids after DM preview.
 * @param {object} input
 * @param {string[]} input.fileIds
 * @param {object[]} input.posts
 * @param {object} input.format
 * @param {object} input.range
 * @returns {Promise<PendingMeta>}
 */
export async function createPending(input) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  if (input.fileIds.length !== input.posts.length) {
    throw new Error("fileIds length must match posts length");
  }

  /** @type {PendingMeta} */
  const meta = {
    id,
    createdAt: new Date().toISOString(),
    status: "pending",
    month: input.range.month,
    rangeLabel: input.range.label,
    pollQuestion: input.format.pollQuestion,
    pollOptions: input.format.pollOptions,
    isAnonymous: input.format.isAnonymous,
    allowsMultipleAnswers: input.format.allowsMultipleAnswers,
    channelUsername: config.channelUsername,
    groupChatId: String(config.groupChatId || ""),
    photos: input.posts.map((post, i) => ({
      fileId: input.fileIds[i],
      sourceId: post.id,
      score: post.score,
      messageLink: post.messageLink,
    })),
  };

  await savePendingMeta(meta);
  return meta;
}

/**
 * @param {string} id
 * @returns {Promise<PendingMeta | null>}
 */
export async function loadPending(id) {
  if (useBlob()) {
    const { list } = await import("@vercel/blob");
    // Direct URL pattern — list by prefix
    const result = await list({ prefix: `pending/${id}.json` });
    const blob = result.blobs.find((b) => b.pathname === `pending/${id}.json`);
    if (!blob) return null;
    const res = await fetch(blob.url);
    if (!res.ok) return null;
    return res.json();
  }

  const metaPath = path.join(PENDING_ROOT, `${id}.json`);
  if (!fs.existsSync(metaPath)) return null;
  return JSON.parse(fs.readFileSync(metaPath, "utf8"));
}

/**
 * @param {string} id
 * @param {Partial<PendingMeta>} patch
 */
export async function updatePending(id, patch) {
  const meta = await loadPending(id);
  if (!meta) throw new Error(`Pending ${id} not found`);
  const next = { ...meta, ...patch };
  await savePendingMeta(next);
  return next;
}

/** @deprecated use createPending — kept for older call sites */
export function savePending() {
  throw new Error("savePending(buffers) removed — use createPending({ fileIds, posts, format, range })");
}

/** @deprecated */
export function loadPendingPhotos() {
  throw new Error("loadPendingPhotos removed — use pending.photos[].fileId with Bot API");
}
