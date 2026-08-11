/**
 * Batch media_group updates from Bot API into one Members queue item.
 * Same concurrency approach as admin album parts.
 */
import fs from "node:fs";
import path from "node:path";
import { runInBackground, sleep } from "../queue/albumBatch.js";

const LOCAL_ROOT = path.resolve("./data/members/albums");
const BLOB_PREFIX = "members/albums/";

function useBlob() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function keyOf(chatId, groupId) {
  return `${chatId}_${groupId}`;
}

/**
 * @param {string|number} chatId
 * @param {string} groupId
 * @param {object} part
 */
export async function recordMemberAlbumPart(chatId, groupId, part) {
  const key = keyOf(chatId, groupId);
  const partId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const body = JSON.stringify({
    partId,
    at: Date.now(),
    fileId: part.fileId,
    mediaType: part.mediaType || "photo",
    caption: part.caption || "",
    fromUserId: part.fromUserId || "",
    fromUsername: part.fromUsername || "",
    messageId: part.messageId || 0,
    directMessagesTopicId: part.directMessagesTopicId ?? null,
    messageThreadId: part.messageThreadId ?? null,
  });

  if (useBlob()) {
    const { put } = await import("@vercel/blob");
    await put(`${BLOB_PREFIX}${key}/part-${partId}.json`, body, {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } else {
    const dir = path.join(LOCAL_ROOT, key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `part-${partId}.json`), body, "utf8");
  }
  return key;
}

async function listParts(key) {
  if (useBlob()) {
    const { list } = await import("@vercel/blob");
    const result = await list({ prefix: `${BLOB_PREFIX}${key}/part-` });
    const parts = [];
    for (const blob of result.blobs) {
      try {
        const res = await fetch(blob.url, { cache: "no-store" });
        if (res.ok) parts.push(await res.json());
      } catch {
        /* skip */
      }
    }
    return parts;
  }
  const dir = path.join(LOCAL_ROOT, key);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("part-"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function tryClaim(key, quietMs) {
  const parts = await listParts(key);
  if (!parts.length) return null;
  const lastAt = Math.max(...parts.map((p) => p.at || 0));
  if (Date.now() - lastAt < quietMs) return null;

  if (useBlob()) {
    const { list, put, del } = await import("@vercel/blob");
    const lockPath = `${BLOB_PREFIX}${key}/lock.json`;
    const existing = await list({ prefix: lockPath });
    if (existing.blobs.some((b) => b.pathname === lockPath)) return null;
    try {
      await put(lockPath, JSON.stringify({ at: Date.now() }), {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: false,
      });
    } catch {
      return null;
    }
    await sleep(400);
    const parts2 = await listParts(key);
    const last2 = Math.max(...parts2.map((p) => p.at || 0));
    if (Date.now() - last2 < quietMs * 0.4) {
      const locks = await list({ prefix: lockPath });
      for (const b of locks.blobs) {
        if (b.pathname === lockPath) {
          try {
            await del(b.url);
          } catch {
            /* ignore */
          }
        }
      }
      return null;
    }
    return parts2;
  }

  const dir = path.join(LOCAL_ROOT, key);
  const lockFile = path.join(dir, "lock.json");
  try {
    fs.writeFileSync(lockFile, "{}", { flag: "wx" });
  } catch {
    return null;
  }
  await sleep(400);
  const parts2 = await listParts(key);
  const last2 = Math.max(...parts2.map((p) => p.at || 0));
  if (Date.now() - last2 < quietMs * 0.4) {
    try {
      fs.unlinkSync(lockFile);
    } catch {
      /* ignore */
    }
    return null;
  }
  return parts2;
}

async function clearKey(key) {
  if (useBlob()) {
    try {
      const { list, del } = await import("@vercel/blob");
      const result = await list({ prefix: `${BLOB_PREFIX}${key}/` });
      for (const b of result.blobs) {
        try {
          await del(b.url);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    return;
  }
  const dir = path.join(LOCAL_ROOT, key);
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {string|number} chatId
 * @param {string} groupId
 * @param {(parts: object[]) => Promise<void>} onComplete
 */
export function scheduleMemberAlbumFinalize(chatId, groupId, onComplete) {
  const key = keyOf(chatId, groupId);
  runInBackground(async () => {
    await sleep(3000);
    let parts = await tryClaim(key, 2500);
    if (!parts) {
      await sleep(3000);
      parts = await tryClaim(key, 2000);
    }
    if (!parts?.length) return;
    // sort by message id for stable order
    parts.sort((a, b) => (a.messageId || 0) - (b.messageId || 0));
    try {
      await onComplete(parts);
    } finally {
      await clearKey(key);
    }
  });
}
