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
 * Try to claim finalize. Returns part stats if this caller won and batch is quiet.
 * @returns {Promise<{ count: number } | null>}
 */
export async function tryClaimAlbumFinalize(chatId, groupId, quietMs = 2500) {
  const key = albumKey(chatId, groupId);
  const { count, lastAt } = await readAlbumParts(key);
  if (count === 0) return null;
  if (Date.now() - lastAt < quietMs) return null;

  // Claim lock
  if (useRemote()) {
    const { list, put, del } = await import("../storage/blob.js");
    const lockPath = lockPathname(key);
    const existing = await list({ prefix: lockPath });
    if (existing.blobs.some((b) => b.pathname === lockPath)) {
      return null; // already claimed
    }
    await put(
      lockPath,
      JSON.stringify({ claimedAt: Date.now(), count }),
      {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: false, // may fail if exists — good
      },
    ).catch(() => null);

    // Re-check someone else won
    const after = await list({ prefix: lockPath });
    const lockBlob = after.blobs.find((b) => b.pathname === lockPath);
    if (!lockBlob) return null;

    // Re-count after quiet (late arrivals)
    await sleep(400);
    const again = await readAlbumParts(key);
    if (Date.now() - again.lastAt < quietMs * 0.5) {
      // more arrived — release lock and abort (another finalizer will run)
      try {
        await del(lockBlob.url);
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
  const again = await readAlbumParts(key);
  if (Date.now() - again.lastAt < quietMs * 0.5) {
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
          await del(blob.url);
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
