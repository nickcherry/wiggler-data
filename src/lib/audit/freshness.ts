import { formatDurationMs } from "@wiggler/lib/time/durations";

/**
 * Result of an `ageFrom` calculation: integer milliseconds since the event
 * (or `null` when no event exists) plus a pre-rendered human label.
 */
export type Freshness = Readonly<{
  ageMs: number | null;
  display: string;
}>;

/**
 * Computes the age of an event timestamp relative to `nowMs` and renders it
 * as a short human label.
 *
 * Negative ages are clamped to 0. They occur naturally because Polymarket's
 * `received_at` is taken at insert time on a remote clock, while audit
 * queries compare against this process's `Date.now()`. Sub-second clock
 * skew between two clocks reads as "the future" and is operationally
 * indistinguishable from "happening right now."
 */
export function ageFrom(date: Date | null, nowMs: number): Freshness {
  if (date === null) {
    return { ageMs: null, display: "(no data)" };
  }
  const rawAgeMs = nowMs - date.getTime();
  const ageMs = rawAgeMs < 0 ? 0 : rawAgeMs;
  return { ageMs, display: formatDurationMs(ageMs) };
}
