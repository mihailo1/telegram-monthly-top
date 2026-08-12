/**
 * Album / media-group batching for a single user-facing ack.
 *
 * Concurrency-safe: each incoming media writes its own part file.
 * Finalize runs in background after a quiet period and sends ONE summary.
 *
 * Blob:
 *   queue/albums/{key}/part-{id}.json
 *   queue/albums/{key}/lock.json   (finalize claim)
 * Local mirrors under data/queue/albums/
 */
import fs from "node:fs";
import path from "node:path";

const LOCAL_ROOT = path.resolve("./data/queue/albums");
const BLOB_PREFIX = "queue/albums/";

function useRemote() {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN ||
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN,
  );
}

export function albumKey(chatId, groupId) {
  return `${chatId}_${groupId}`;
}

function partPathname(key, partId) {
  return `${BLOB_PREFIX}${key}/part-${partId}.json`;
}

function lockPathname(key) {
  return `${BLOB_PREFIX}${key}/lock.json`;
}

function localDir(key) {
  return path.join(LOCAL_ROOT, key);
}

function newPartId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Record one media in the batch (call after enqueue to queue).
 * @returns {Promise<{ key: string, partId: string }>}
 */
export async function recordAlbumPart(chatId, groupId) {
  const key = albumKey(chatId, groupId);
  const partId = newPartId();
  const body = JSON.stringify({ partId, at: Date.now() });

  if (useRemote()) {
    const { put } = await import("../storage/blob.js");
    await put(partPathname(key, partId), body, {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } else {
    const dir = localDir(key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `part-${partId}.json`), body, "utf8");
  }

  return { key, partId };
}

/**
 * @returns {Promise<{ count: number, lastAt: number }>}
 */
export async function readAlbumParts(key) {
  if (useRemote()) {
    const { list } = await import("../storage/blob.js");
    const result = await list({ prefix: `${BLOB_PREFIX}${key}/part-` });
    let lastAt = 0;
    let count = 0;
    for (const blob of result.blobs) {
      if (!blob.pathname.includes("/part-")) continue;
      count += 1;
      try {
        const { getJson } = await import("../storage/blob.js");
        const j = await getJson(blob.pathname);
        if (j?.at > lastAt) lastAt = j.at;
      } catch {
        /* count file even if body bad */
        lastAt = Math.max(lastAt, Date.now());
      }
    }
    return { count, lastAt };
  }

  const dir = localDir(key);
  if (!fs.existsSync(dir)) return { count: 0, lastAt: 0 };
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("part-"));
  let lastAt = 0;
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (j?.at > lastAt) lastAt = j.at;
    } catch {
      /* ignore */
    }
  }
  return { count: files.length, lastAt };
}

/**
 * Album quiet timing: GitHub storage serializes writes (~3–5s per photo),
 * so short quiet windows falsely finalize mid-album.
 */
export function albumQuietMs() {
  if (
    process.env.STORAGE_BACKEND === "github" ||
    (!process.env.BLOB_READ_WRITE_TOKEN &&
      (process.env.GITHUB_TOKEN || process.env.GH_TOKEN))
  ) {
    return 10_000;
  }
  return 2500;
}

export function albumInitialWaitMs() {
  return albumQuietMs() + 2000;
}

/**
 * Try to claim finalize. Count comes from queue items with mediaGroupId
 * (source of truth), not from part files (can lag / finalize early).
 * @returns {Promise<{ count: number } | null>}
 */
export async function tryClaimAlbumFinalize(chatId, groupId, quietMs) {
  const quiet = quietMs ?? albumQuietMs();
  const key = albumKey(chatId, groupId);
  const { countMediaGroupItems } = await import("./store.js");

  const snap = await countMediaGroupItems(groupId);
  // fallback to part files if mediaGroupId not on items (legacy)
  const parts = snap.count > 0 ? snap : await readAlbumParts(key);
  if (parts.count === 0) return null;
  if (Date.now() - parts.lastAt < quiet) return null;

  // Claim lock
  if (useRemote()) {
    const { list, put, del } = await import("../storage/blob.js");
    const lockPath = lockPathname(key);
    const existing = await list({ prefix: lockPath });
    if (existing.blobs.some((b) => b.pathname === lockPath)) {
      return null; // already claimed
    }
    try {
      await put(
        lockPath,
        JSON.stringify({ claimedAt: Date.now(), count: parts.count }),
        {
          access: "public",
          contentType: "application/json",
          addRandomSuffix: false,
          allowOverwrite: false,
        },
      );
    } catch {
      return null;
    }

    const after = await list({ prefix: lockPath });
    const lockBlob = after.blobs.find((b) => b.pathname === lockPath);
    if (!lockBlob) return null;

    // Re-count after settle (late album frames still writing)
    await sleep(Math.min(1500, Math.floor(quiet * 0.2)));
    const againSnap = await countMediaGroupItems(groupId);
    const again = againSnap.count > 0 ? againSnap : await readAlbumParts(key);
    if (Date.now() - again.lastAt < quiet * 0.45) {
      try {
        await del(lockBlob.pathname || lockBlob.url);
      } catch {
        /* ignore */
      }
      return null;
    }
    return { count: again.count };
  }

  // Local lock file
  const dir = localDir(key);
  const lockFile = path.join(dir, "lock.json");
  if (fs.existsSync(lockFile)) return null;
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(lockFile, JSON.stringify({ claimedAt: Date.now() }), {
      flag: "wx",
    });
  } catch {
    return null;
  }
  await sleep(400);
  const againSnap = await countMediaGroupItems(groupId);
  const again = againSnap.count > 0 ? againSnap : await readAlbumParts(key);
  if (Date.now() - again.lastAt < quiet * 0.45) {
    try {
      fs.unlinkSync(lockFile);
    } catch {
      /* ignore */
    }
    return null;
  }
  return { count: again.count };
}

export async function clearAlbumBatch(chatId, groupId) {
  const key = albumKey(chatId, groupId);
  if (useRemote()) {
    try {
      const { list, del } = await import("../storage/blob.js");
      const result = await list({ prefix: `${BLOB_PREFIX}${key}/` });
      for (const blob of result.blobs) {
        try {
          await del(blob.pathname || blob.url);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    return;
  }
  const dir = localDir(key);
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    /* ignore */
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {() => Promise<void>} fn
 */
export function runInBackground(fn) {
  const runner = () =>
    fn().catch((err) => console.error("background task", err.message ?? err));

  import("@vercel/functions")
    .then(({ waitUntil }) => {
      if (typeof waitUntil === "function") waitUntil(runner());
      else setTimeout(runner, 0);
    })
    .catch(() => setTimeout(runner, 0));
}

// legacy names used by botApp
export const bumpAlbumBatch = recordAlbumPart;
export async function tryFinalizeAlbumBatch(chatId, groupId, quietMs) {
  return tryClaimAlbumFinalize(chatId, groupId, quietMs);
}
