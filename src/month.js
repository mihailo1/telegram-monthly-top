/**
 * Previous calendar month bounds in a fixed-offset-friendly way.
 * Europe/Moscow is UTC+3 year-round (no DST).
 *
 * Returns half-open range [from, to) as Date objects (UTC instants).
 */

const TZ_OFFSET_HOURS = {
  "Europe/Moscow": 3,
};

/**
 * @param {string} [timeZone]
 * @param {Date} [now]
 * @returns {{ from: Date, to: Date, label: string, year: number, month: number }}
 */
export function previousMonthRange(timeZone = "Europe/Moscow", now = new Date()) {
  const offsetH = TZ_OFFSET_HOURS[timeZone];
  if (offsetH === undefined) {
    // Fallback: use Intl local Y-M in that zone, assume current offset from a sample
    return previousMonthRangeIntl(timeZone, now);
  }

  const offsetMs = offsetH * 3600 * 1000;
  // "Wall clock" in target TZ expressed as UTC components
  const wall = new Date(now.getTime() + offsetMs);
  const y = wall.getUTCFullYear();
  const m = wall.getUTCMonth(); // 0–11 = current month in TZ

  // Previous month year/month
  const prevMonthIndex = m === 0 ? 11 : m - 1;
  const prevYear = m === 0 ? y - 1 : y;

  // 00:00 on 1st of previous / current month in TZ → UTC instant
  const from = new Date(Date.UTC(prevYear, prevMonthIndex, 1) - offsetMs);
  const to = new Date(Date.UTC(y, m, 1) - offsetMs);

  const label = new Date(Date.UTC(prevYear, prevMonthIndex, 15)).toLocaleDateString(
    "en-US",
    { month: "long", year: "numeric", timeZone: "UTC" },
  );

  return {
    from,
    to,
    label,
    year: prevYear,
    /** 1–12 */
    month: prevMonthIndex + 1,
  };
}

/** Generic path via Intl (best-effort for non-Moscow zones). */
function previousMonthRangeIntl(timeZone, now) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );
  let y = Number(parts.year);
  let m = Number(parts.month); // 1–12
  m -= 1;
  if (m === 0) {
    m = 12;
    y -= 1;
  }
  // Approximate: treat as UTC date boundaries (not perfect for all TZs)
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to =
    m === 12 ? new Date(Date.UTC(y + 1, 0, 1)) : new Date(Date.UTC(y, m, 1));
  const label = from.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return { from, to, label, year: y, month: m };
}
