/**
 * Time/session classification helpers for the experiment report.
 *
 * Sessions are defined in America/New_York wall clock per the spec:
 *
 *   weekday_us_cash:     Mon-Fri 09:30-16:00 ET
 *   weekday_us_extended: Mon-Fri 08:00-09:30 and 16:00-20:00 ET
 *   weekday_overnight:   Mon-Fri outside 08:00-20:00 ET
 *   weekend:             Sat-Sun
 *
 * DST is handled by `Intl.DateTimeFormat` (with timeZone = America/New_York).
 * We extract weekday + hour + minute via `formatToParts` rather than
 * pre-computing a fixed offset, so spring-forward / fall-back days
 * classify correctly.
 *
 * ~150k formatToParts calls per asset is the upper bound we hit;
 * Intl-on-Bun handles that in well under a second per asset.
 */

export const SESSIONS = [
  "weekday_us_cash",
  "weekday_us_extended",
  "weekday_overnight",
  "weekend",
] as const;
export type Session = (typeof SESSIONS)[number];

const ET_PARTS_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const UTC_HOUR_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  hour: "2-digit",
  hour12: false,
});

const ET_DAY_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
});

/** Sun=0, Mon=1, ..., Sat=6 — same convention as JS Date.getDay(). */
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export type EtBreakdown = Readonly<{
  session: Session;
  weekdayShort: Weekday;
  weekdayIdx: number;
  etHour: number;
  etMinute: number;
}>;

/**
 * Returns the ET-local breakdown of `tsMs`. One Intl call per row;
 * results are intentionally not cached because per-row caching here
 * is slower than the formatter itself.
 */
export function classifyEt(tsMs: number): EtBreakdown {
  const parts = ET_PARTS_FMT.formatToParts(new Date(tsMs));
  let weekdayShort: Weekday = "Mon";
  let etHour = 0;
  let etMinute = 0;
  for (const p of parts) {
    if (p.type === "weekday") {
      weekdayShort = (p.value as Weekday) ?? "Mon";
    } else if (p.type === "hour") {
      // Intl returns "24" for midnight in en-US `hour12: false`; clamp it.
      const h = Number.parseInt(p.value, 10);
      etHour = h === 24 ? 0 : h;
    } else if (p.type === "minute") {
      etMinute = Number.parseInt(p.value, 10);
    }
  }
  const weekdayIdx = WEEKDAY_INDEX[weekdayShort] ?? 1;
  let session: Session;
  if (weekdayIdx === 0 || weekdayIdx === 6) {
    session = "weekend";
  } else {
    const minuteOfDay = etHour * 60 + etMinute;
    const cashOpen = 9 * 60 + 30;
    const cashClose = 16 * 60;
    const extendedAmStart = 8 * 60;
    const extendedPmEnd = 20 * 60;
    if (minuteOfDay >= cashOpen && minuteOfDay < cashClose) {
      session = "weekday_us_cash";
    } else if (
      (minuteOfDay >= extendedAmStart && minuteOfDay < cashOpen) ||
      (minuteOfDay >= cashClose && minuteOfDay < extendedPmEnd)
    ) {
      session = "weekday_us_extended";
    } else {
      session = "weekday_overnight";
    }
  }
  return { session, weekdayShort, weekdayIdx, etHour, etMinute };
}

/** Returns the UTC hour 0..23 of `tsMs`. */
export function utcHour(tsMs: number): number {
  const parts = UTC_HOUR_FMT.formatToParts(new Date(tsMs));
  for (const p of parts) {
    if (p.type === "hour") {
      const h = Number.parseInt(p.value, 10);
      return h === 24 ? 0 : h;
    }
  }
  return 0;
}

/** Returns the ET weekday short name. Cheaper than `classifyEt` when
 *  only the day-of-week is needed. */
export function etWeekdayShort(tsMs: number): Weekday {
  const parts = ET_DAY_FMT.formatToParts(new Date(tsMs));
  for (const p of parts) {
    if (p.type === "weekday") {
      return (p.value as Weekday) ?? "Mon";
    }
  }
  return "Mon";
}

/**
 * Minute-of-hour of the supplied UTC ms (0, 1, ..., 59). For the slot
 * experiment we want minute-of-hour at MARKET START in UTC — Polymarket
 * markets are scheduled in UTC even though we look at ET sessions.
 */
export function minuteOfHourUtc(tsMs: number): number {
  return Math.floor((tsMs % 3_600_000) / 60_000);
}
