/**
 * Last channel post clock — drives 1h spacing for members + admin deferral.
 */
import fs from "node:fs";
import path from "node:path";
import { getJson, list as storeList, put as storePut } from "../storage/blob.js";

const LOCAL_PATH = path.resolve("./data/channel-pulse.json");
const BLOB_KEY = "scheduler/channel-pulse.json";
export const PULSE_GAP_MS = 60 * 60 * 1000; // 1 hour

function useRemote() {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN ||
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN,
  );
}

/**
 * @typedef {object} ChannelPulse
 * @property {string} [lastPostedAt] ISO
 * @property {"members"|"admin"} [lastKind]
 * @property {string} [lastItemId]
 * @property {string} updatedAt
 */

/** @returns {Promise<ChannelPulse>} */
export async function loadChannelPulse() {
  if (useRemote()) {
    try {
      const result = await storeList({ prefix: BLOB_KEY });
      const blob = result.blobs.find((b) => b.pathname === BLOB_KEY);
      if (!blob) return { updatedAt: new Date().toISOString() };
      return await getJson(blob.pathname);
    } catch {
      return { updatedAt: new Date().toISOString() };
    }
  }
  if (!fs.existsSync(LOCAL_PATH)) return { updatedAt: new Date().toISOString() };
  try {
    return JSON.parse(fs.readFileSync(LOCAL_PATH, "utf8"));
  } catch {
    return { updatedAt: new Date().toISOString() };
  }
}

/** @param {ChannelPulse} pulse */
export async function saveChannelPulse(pulse) {
  pulse.updatedAt = new Date().toISOString();
  const body = JSON.stringify(pulse, null, 2);
  if (useRemote()) {
    await storePut(BLOB_KEY, body, {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return;
  }
  fs.mkdirSync(path.dirname(LOCAL_PATH), { recursive: true });
  fs.writeFileSync(LOCAL_PATH, body, "utf8");
}

/**
 * @param {"members"|"admin"} kind
 * @param {string} [itemId]
 */
export async function markChannelPosted(kind, itemId) {
  await saveChannelPulse({
    lastPostedAt: new Date().toISOString(),
    lastKind: kind,
    lastItemId: itemId || "",
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Earliest instant we may post again (now, or lastPost+1h).
 * @param {ChannelPulse} [pulse]
 * @param {number} [nowMs]
 */
export function nextAllowedAt(pulse, nowMs = Date.now()) {
  const last = pulse?.lastPostedAt ? new Date(pulse.lastPostedAt).getTime() : 0;
  if (!last) return new Date(nowMs);
  return new Date(Math.max(nowMs, last + PULSE_GAP_MS));
}

/**
 * @param {ChannelPulse} pulse
 * @param {number} [nowMs]
 */
export function msSinceLastPost(pulse, nowMs = Date.now()) {
  if (!pulse?.lastPostedAt) return Infinity;
  return nowMs - new Date(pulse.lastPostedAt).getTime();
}
