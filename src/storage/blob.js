/**
 * Drop-in storage for queue / members / day-state.
 *
 * Backends (auto):
 * 1. Vercel Blob — if BLOB_READ_WRITE_TOKEN works (put succeeds)
 * 2. GitHub branch — if GITHUB_TOKEN set (or GH_TOKEN)
 *
 * Public shape matches the subset of @vercel/blob we use:
 *   put(pathname, body, opts) → { url, pathname }
 *   list({ prefix, limit, cursor }) → { blobs, hasMore, cursor }
 *   del(urlOrPathname | string[]) → void
 *   getJson(pathname|url) → any
 *   getText(pathname|url) → string
 */
import { config } from "../config.js";

const GH_API = "https://api.github.com";

/** @type {"blob"|"github"|null} */
let resolvedBackend = null;
/** @type {boolean|null} */
let blobHealthy = null;

function ghToken() {
  return (
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_STORE_TOKEN ||
    ""
  ).trim();
}

function ghRepo() {
  return (
    process.env.GITHUB_STORE_REPO ||
    process.env.GITHUB_REPOSITORY ||
    "mihailo1/telegram-monthly-top"
  ).trim();
}

function ghBranch() {
  return (process.env.GITHUB_STORE_BRANCH || "store-data").trim();
}

function blobToken() {
  return (process.env.BLOB_READ_WRITE_TOKEN || "").trim();
}

/**
 * Probe Vercel Blob once per cold start.
 * Suspended stores still list() but put/fetch fail — treat as dead.
 */
async function isBlobHealthy() {
  if (blobHealthy != null) return blobHealthy;
  if (!blobToken()) {
    blobHealthy = false;
    return false;
  }
  try {
    const { put } = await import("@vercel/blob");
    const p = await put(
      "queue/_healthcheck.json",
      JSON.stringify({ t: Date.now() }),
      {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true,
      },
    );
    const res = await fetch(`${p.url}?t=${Date.now()}`, { cache: "no-store" });
    blobHealthy = res.ok;
    if (!blobHealthy) {
      console.error(
        "Vercel Blob unhealthy: fetch",
        res.status,
        (await res.text()).slice(0, 80),
      );
    }
  } catch (err) {
    blobHealthy = false;
    console.error(
      "Vercel Blob unhealthy:",
      err?.name || "",
      err?.message || err,
    );
  }
  return blobHealthy;
}

async function backend() {
  if (resolvedBackend) return resolvedBackend;
  if (process.env.STORAGE_BACKEND === "github") {
    resolvedBackend = "github";
    return resolvedBackend;
  }
  if (process.env.STORAGE_BACKEND === "blob") {
    resolvedBackend = "blob";
    return resolvedBackend;
  }
  if (await isBlobHealthy()) {
    resolvedBackend = "blob";
  } else if (ghToken()) {
    console.warn("storage: using GitHub branch backend (Blob unavailable)");
    resolvedBackend = "github";
  } else {
    throw new Error(
      "No storage backend: Blob suspended/unavailable and GITHUB_TOKEN not set",
    );
  }
  return resolvedBackend;
}

function pathnameFromRef(ref) {
  if (!ref) return "";
  if (!String(ref).includes("://")) {
    return String(ref).replace(/^\//, "");
  }
  try {
    const u = new URL(ref);
    // vercel blob: host/.../pathname or pathname after store id
    const p = u.pathname.replace(/^\//, "");
    // github raw: /owner/repo/branch/path
    const m = p.match(
      /^[^/]+\/[^/]+\/(?:raw|blob)\/[^/]+\/(.+)$/,
    );
    if (m) return decodeURIComponent(m[1]);
    // public.blob.vercel-storage.com/<pathname>
    return decodeURIComponent(p);
  } catch {
    return String(ref);
  }
}

// ─── GitHub Contents API ───────────────────────────────────────────

async function ghFetch(path, init = {}) {
  const token = ghToken();
  if (!token) throw new Error("GITHUB_TOKEN missing for GitHub storage");
  const res = await fetch(`${GH_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  return res;
}

async function ghGetFile(pathname) {
  const repo = ghRepo();
  const branch = ghBranch();
  const res = await ghFetch(
    `/repos/${repo}/contents/${encodeURI(pathname)}?ref=${encodeURIComponent(branch)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`github get ${pathname}: ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json();
}

async function ghPut(pathname, body, { allowOverwrite = true } = {}) {
  const repo = ghRepo();
  const branch = ghBranch();
  const content =
    typeof body === "string" || Buffer.isBuffer(body)
      ? Buffer.from(body).toString("base64")
      : Buffer.from(JSON.stringify(body)).toString("base64");

  let sha;
  const existing = await ghGetFile(pathname);
  if (existing?.sha) {
    if (!allowOverwrite) {
      const err = new Error("file exists");
      err.statusCode = 409;
      throw err;
    }
    sha = existing.sha;
  }

  const res = await ghFetch(`/repos/${repo}/contents/${encodeURI(pathname)}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `store: put ${pathname}`,
      content,
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    // retry once on SHA conflict
    if (res.status === 409 || res.status === 422) {
      const again = await ghGetFile(pathname);
      if (again?.sha) {
        const res2 = await ghFetch(
          `/repos/${repo}/contents/${encodeURI(pathname)}`,
          {
            method: "PUT",
            body: JSON.stringify({
              message: `store: put ${pathname} (retry)`,
              content,
              branch,
              sha: again.sha,
            }),
          },
        );
        if (!res2.ok) {
          throw new Error(
            `github put retry ${pathname}: ${res2.status} ${(await res2.text()).slice(0, 200)}`,
          );
        }
        const j2 = await res2.json();
        return {
          url: j2.content?.download_url || ghRawUrl(pathname),
          pathname,
        };
      }
    }
    throw new Error(`github put ${pathname}: ${res.status} ${t.slice(0, 200)}`);
  }
  const j = await res.json();
  return { url: j.content?.download_url || ghRawUrl(pathname), pathname };
}

function ghRawUrl(pathname) {
  return `https://raw.githubusercontent.com/${ghRepo()}/${ghBranch()}/${pathname}`;
}

async function ghList(prefix = "", limit = 1000) {
  const repo = ghRepo();
  const branch = ghBranch();
  // recursive tree
  const refRes = await ghFetch(`/repos/${repo}/git/ref/heads/${branch}`);
  if (!refRes.ok) {
    if (refRes.status === 404) return { blobs: [], hasMore: false };
    throw new Error(`github ref: ${refRes.status}`);
  }
  const ref = await refRes.json();
  const sha = ref.object?.sha;
  const treeRes = await ghFetch(
    `/repos/${repo}/git/trees/${sha}?recursive=1`,
  );
  if (!treeRes.ok) {
    throw new Error(`github tree: ${treeRes.status}`);
  }
  const tree = await treeRes.json();
  const pfx = prefix || "";
  const blobs = (tree.tree || [])
    .filter((n) => n.type === "blob" && (!pfx || n.path.startsWith(pfx)))
    .slice(0, limit)
    .map((n) => ({
      pathname: n.path,
      url: ghRawUrl(n.path),
      size: n.size || 0,
      uploadedAt: new Date(),
    }));
  return { blobs, hasMore: false, cursor: undefined };
}

async function ghDel(pathname) {
  const existing = await ghGetFile(pathname);
  if (!existing?.sha) return;
  const repo = ghRepo();
  const branch = ghBranch();
  const res = await ghFetch(`/repos/${repo}/contents/${encodeURI(pathname)}`, {
    method: "DELETE",
    body: JSON.stringify({
      message: `store: del ${pathname}`,
      sha: existing.sha,
      branch,
    }),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `github del ${pathname}: ${res.status} ${(await res.text()).slice(0, 200)}`,
    );
  }
}

async function ghGetText(pathname) {
  const file = await ghGetFile(pathname);
  if (!file) {
    const err = new Error("not found");
    err.statusCode = 404;
    throw err;
  }
  if (file.encoding === "base64" && file.content) {
    return Buffer.from(file.content.replace(/\n/g, ""), "base64").toString(
      "utf8",
    );
  }
  if (file.download_url) {
    const res = await fetch(file.download_url, {
      headers: { Authorization: `Bearer ${ghToken()}` },
    });
    if (!res.ok) throw new Error(`github download ${pathname}: ${res.status}`);
    return res.text();
  }
  throw new Error(`github getText empty ${pathname}`);
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * @param {string} pathname
 * @param {string|Buffer|ArrayBuffer} body
 * @param {{ access?: string, contentType?: string, addRandomSuffix?: boolean, allowOverwrite?: boolean }} [opts]
 */
export async function put(pathname, body, opts = {}) {
  const be = await backend();
  const allowOverwrite = opts.allowOverwrite !== false;
  if (be === "blob") {
    const { put: vput } = await import("@vercel/blob");
    return vput(pathname, body, {
      access: opts.access || "public",
      contentType: opts.contentType || "application/json",
      addRandomSuffix: opts.addRandomSuffix ?? false,
      allowOverwrite,
    });
  }
  const str =
    typeof body === "string"
      ? body
      : Buffer.isBuffer(body)
        ? body.toString("utf8")
        : body instanceof ArrayBuffer
          ? Buffer.from(body).toString("utf8")
          : String(body);
  try {
    return await ghPut(pathname, str, { allowOverwrite });
  } catch (err) {
    if (!allowOverwrite && (err.statusCode === 409 || /exists/i.test(err.message))) {
      // mimic vercel put allowOverwrite:false
      throw err;
    }
    throw err;
  }
}

/**
 * @param {{ prefix?: string, limit?: number, cursor?: string }} [opts]
 */
export async function list(opts = {}) {
  const be = await backend();
  if (be === "blob") {
    const { list: vlist } = await import("@vercel/blob");
    return vlist(opts);
  }
  return ghList(opts.prefix || "", opts.limit || 1000);
}

/**
 * @param {string|string[]} urlOrPathname
 */
export async function del(urlOrPathname) {
  const be = await backend();
  const refs = Array.isArray(urlOrPathname) ? urlOrPathname : [urlOrPathname];
  if (be === "blob") {
    const { del: vdel } = await import("@vercel/blob");
    await vdel(refs);
    return;
  }
  for (const ref of refs) {
    await ghDel(pathnameFromRef(ref));
  }
}

/**
 * Read blob body as text (works when public URL is blocked).
 * @param {string} pathnameOrUrl
 */
export async function getText(pathnameOrUrl) {
  const pathname = pathnameFromRef(pathnameOrUrl);
  const be = await backend();
  if (be === "blob") {
    // Prefer list+fetch; if blocked, fail clearly
    const { head } = await import("@vercel/blob");
    try {
      const h = await head(pathname);
      const res = await fetch(h.url, { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`blob fetch ${pathname}: ${res.status}`);
      }
      return res.text();
    } catch (err) {
      // fallback: try url as-is
      if (String(pathnameOrUrl).startsWith("http")) {
        const res = await fetch(pathnameOrUrl, { cache: "no-store" });
        if (res.ok) return res.text();
      }
      throw err;
    }
  }
  return ghGetText(pathname);
}

/**
 * @param {string} pathnameOrUrl
 */
export async function getJson(pathnameOrUrl) {
  const text = await getText(pathnameOrUrl);
  return JSON.parse(text);
}

/** For diagnostics */
export async function storageInfo() {
  const be = await backend().catch((e) => `error:${e.message}`);
  return {
    backend: be,
    blobToken: Boolean(blobToken()),
    blobHealthy,
    githubToken: Boolean(ghToken()),
    githubRepo: ghRepo(),
    githubBranch: ghBranch(),
  };
}

// re-export name used by health checks
export { isBlobHealthy };
