/**
 * Track how many posts went out per calendar day (local TZ).
 * Used for limits: admin 1/day exclusive; members up to 4/day if no admin that day.
 */
import fs from "node:fs";
import path from "node:path";
import { localDayString } from "../queue/time.js";
import { config } from "../config.js";

const LOCAL_PATH = path.resolve("./data/day-state.json");
const BLOB_KEY = "scheduler/day-state.json";

function useBlob() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

/**
 * @typedef {object} DayRecord
 * @property {number} admin
 * @property {number} members
 */

/**
 * @typedef {object} DayStateFile
 * @property {Record<string, DayRecord>} days
 * @property {string} updatedAt
 */

/** @returns {Promise<DayStateFile>} */
export async function loadDayState() {
  if (useBlob()) {
    try {
      const { list } = await import("@vercel/blob");
      const result = await list({ prefix: BLOB_KEY });
      const blob = result.blobs.find((b) => b.pathname === BLOB_KEY);
      if (!blob) return { days: {}, updatedAt: new Date().toISOString() };
      const res = await fetch(blob.url, { cache: "no-store" });
      if (!res.ok) return { days: {}, updatedAt: new Date().toISOString() };
      return await res.json();
    } catch {
      return { days: {}, updatedAt: new Date().toISOString() };
    }
  }
  if (!fs.existsSync(LOCAL_PATH)) {
    return { days: {}, updatedAt: new Date().toISOString() };
  }
  try {
    return JSON.parse(fs.readFileSync(LOCAL_PATH, "utf8"));
  } catch {
    return { days: {}, updatedAt: new Date().toISOString() };
  }
}

/** @param {DayStateFile} state */
export async function saveDayState(state) {
  state.updatedAt = new Date().toISOString();
  const body = JSON.stringify(state, null, 2);
  if (useBlob()) {
    const { put } = await import("@vercel/blob");
    await put(BLOB_KEY, body, {
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
 * @param {string} [day]
 * @returns {Promise<DayRecord>}
 */
export async function getDayRecord(day) {
  const d = day || localDayString(config.timeZone);
  const state = await loadDayState();
  return state.days[d] || { admin: 0, members: 0 };
}

/**
 * @param {"admin"|"members"} kind
 * @param {string} [day]
 */
export async function incrementDayPost(kind, day) {
  const d = day || localDayString(config.timeZone);
  const state = await loadDayState();
  const rec = state.days[d] || { admin: 0, members: 0 };
  if (kind === "admin") rec.admin += 1;
  else rec.members += 1;
  state.days[d] = rec;
  await saveDayState(state);
  return rec;
}

/**
 * Members can post today only if no admin post today and members < 4.
 * @param {DayRecord} rec
 */
export function membersSlotsLeftToday(rec) {
  if ((rec.admin || 0) > 0) return 0;
  return Math.max(0, 4 - (rec.members || 0));
}

/**
 * Admin can post today only if no members posts and no admin yet.
 * @param {DayRecord} rec
 */
export function adminCanPostToday(rec) {
  return (rec.admin || 0) === 0 && (rec.members || 0) === 0;
}
