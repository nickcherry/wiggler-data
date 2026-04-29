import { FIVE_MINUTE_MS } from "@wiggler/constants/markets";

export type MarketWindow = Readonly<{
  startMs: number;
  endMs: number;
}>;

/**
 * Returns the 5-minute Polymarket market window that contains the given moment.
 * Boundaries are aligned to UTC 5-minute marks.
 */
export function getFiveMinuteWindow(
  reference: Date | number = new Date(),
): MarketWindow {
  const ms = typeof reference === "number" ? reference : reference.getTime();
  const startMs = Math.floor(ms / FIVE_MINUTE_MS) * FIVE_MINUTE_MS;
  return { startMs, endMs: startMs + FIVE_MINUTE_MS };
}

/**
 * Returns the next 5-minute window relative to the given moment.
 */
export function getNextFiveMinuteWindow(
  reference: Date | number = new Date(),
): MarketWindow {
  const current = getFiveMinuteWindow(reference);
  return { startMs: current.endMs, endMs: current.endMs + FIVE_MINUTE_MS };
}

/**
 * Returns a sequence of 5-minute windows with the given lookback and lookahead counts.
 */
export function getFiveMinuteWindowSeries({
  reference = new Date(),
  lookback,
  lookahead,
}: Readonly<{
  reference?: Date | number;
  lookback: number;
  lookahead: number;
}>): readonly MarketWindow[] {
  const current = getFiveMinuteWindow(reference);
  const windows: MarketWindow[] = [];
  for (let i = -lookback; i <= lookahead; i += 1) {
    const startMs = current.startMs + i * FIVE_MINUTE_MS;
    windows.push({ startMs, endMs: startMs + FIVE_MINUTE_MS });
  }
  return windows;
}

/**
 * Validates that a window is exactly 5 minutes and aligned to a 5-minute boundary.
 */
export function assertWellFormedFiveMinuteWindow(window: MarketWindow): void {
  if (window.endMs - window.startMs !== FIVE_MINUTE_MS) {
    throw new Error(
      `Window length must be 5 minutes (${FIVE_MINUTE_MS}ms); got ${window.endMs - window.startMs}ms.`,
    );
  }
  if (window.startMs % FIVE_MINUTE_MS !== 0) {
    throw new Error(
      `Window start ${window.startMs} is not aligned to a 5-minute boundary.`,
    );
  }
}

/**
 * Returns true if the given moment falls within the window (start inclusive, end exclusive).
 */
export function isWithinWindow(window: MarketWindow, reference: Date | number): boolean {
  const ms = typeof reference === "number" ? reference : reference.getTime();
  return ms >= window.startMs && ms < window.endMs;
}
