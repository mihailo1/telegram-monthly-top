/**
 * Track how many posts went out per calendar day (local TZ).
 * Used for limits: admin 1/day exclusive; members up to 4/day if no admin that day.
 */
import fs from "node:fs";
import path from "node:path";
import { localDayString } from "../queue/time.js";
import { config } from "../config.js";
import { getJson, list as storeList, put as storePut } from "../storage/blob.js";

const LOCAL_PATH = path.resolve("./data/day-state.json");
const BLOB_KEY = "scheduler/day-state.json";

function useRemote() {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN ||
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN,
  );
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
  if (useRemote()) {
    try {
      const result = await storeList({ prefix: BLOB_KEY });
      const blob = result.blobs.find((b) => b.pathname === BLOB_KEY);
      if (!blob) return { days: {}, updatedAt: new Date().toISOString() };
      return await getJson(blob.pathname);
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

/**
 * True if admin already used this calendar day (day-state and/or admin queue).
 * Prefer this over day-state alone — Blob counters can lag; queue is source of truth.
 * @param {string} day YYYY-MM-DD in APP_TZ
 * @param {string} [timeZone]
 */
export async function adminPostedOnDay(day, timeZone = config.timeZone) {
  const rec = await getDayRecord(day);
  if ((rec.admin || 0) > 0) return true;

  try {
    const { loadQueue } = await import("../queue/store.js");
    const { items } = await loadQueue();
    for (const item of items) {
      if (item.status !== "posted") continue;
      // Actual wall day of the channel post
      if (item.postedAt) {
        const postedDay = localDayString(timeZone, new Date(item.postedAt));
        if (postedDay === day) return true;
      }
      // Fallback: scheduled day recorded on the item
      if (item.postDay === day) return true;
    }
  } catch (err) {
    console.warn("adminPostedOnDay queue check failed", err?.message || err);
  }
  return false;
}

/**
 * How many members slots left on a day, using day-state + live queues.
 * Admin day → 0. Else 4 minus posted/scheduled members for that day.
 * @param {string} day
 * @param {string} [timeZone]
 */
export async function membersSlotsLeftOnDay(day, timeZone = config.timeZone) {
  if (await adminPostedOnDay(day, timeZone)) return 0;

  const rec = await getDayRecord(day);
  let used = rec.members || 0;

  try {
    const { loadMembersQueue } = await import("../members/store.js");
    const { items } = await loadMembersQueue();
    const fromQueue = items.filter(
      (x) =>
        (x.status === "scheduled" || x.status === "posted") &&
        (x.postDay === day ||
          (x.postedAt &&
            localDayString(timeZone, new Date(x.postedAt)) === day)),
    ).length;
    used = Math.max(used, fromQueue);
  } catch {
    /* keep day-state only */
  }

  return Math.max(0, 4 - used);
}
