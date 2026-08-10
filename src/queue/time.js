/**
 * Time helpers for Europe/Moscow-style fixed offsets and random post windows.
 * Moscow is UTC+3 year-round.
 */

const OFFSET_HOURS = {
  "Europe/Moscow": 3,
};

/**
 * @param {string} timeZone
 * @param {Date} [now]
 * @returns {{ y: number, m: number, d: number, hour: number, minute: number, offsetMs: number }}
 */
export function wallClock(timeZone = "Europe/Moscow", now = new Date()) {
  const offsetH = OFFSET_HOURS[timeZone] ?? 3;
  const offsetMs = offsetH * 3600 * 1000;
  const wall = new Date(now.getTime() + offsetMs);
  return {
    y: wall.getUTCFullYear(),
    m: wall.getUTCMonth() + 1,
    d: wall.getUTCDate(),
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
    offsetMs,
  };
}

/**
 * @param {string} timeZone
 * @param {Date} [now]
 * @returns {string} YYYY-MM-DD in local TZ
 */
export function localDayString(timeZone = "Europe/Moscow", now = new Date()) {
  const { y, m, d } = wallClock(timeZone, now);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Add calendar days to a YYYY-MM-DD string.
 * @param {string} dayStr
 * @param {number} days
 */
export function addDays(dayStr, days) {
  const [y, m, d] = dayStr.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, d + days);
  const dt = new Date(utc);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Instant for local wall time on a given local day.
 * @param {string} dayStr YYYY-MM-DD
 * @param {number} hour 0–23
 * @param {number} minute 0–59
 * @param {string} timeZone
 * @returns {Date}
 */
export function localDateTime(dayStr, hour, minute, timeZone = "Europe/Moscow") {
  const offsetH = OFFSET_HOURS[timeZone] ?? 3;
  const [y, m, d] = dayStr.split("-").map(Number);
  // wall clock as UTC components then subtract offset
  return new Date(Date.UTC(y, m - 1, d, hour, minute, 0) - offsetH * 3600 * 1000);
}

/**
 * Random post time on dayStr between 10:00 inclusive and 22:00 exclusive (local).
 * @param {string} dayStr
 * @param {string} timeZone
 * @returns {Date}
 */
export function randomPostAt(dayStr, timeZone = "Europe/Moscow") {
  const startMin = 10 * 60; // 10:00
  const endMin = 22 * 60; // 22:00 exclusive → last slot 21:59
  const span = endMin - startMin;
  const minuteOfDay = startMin + Math.floor(Math.random() * span);
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return localDateTime(dayStr, hour, minute, timeZone);
}

/**
 * Format instant in local TZ for humans.
 * @param {Date|string} when
 * @param {string} timeZone
 */
export function formatLocal(when, timeZone = "Europe/Moscow") {
  const d = typeof when === "string" ? new Date(when) : when;
  return d.toLocaleString("ru-RU", {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
