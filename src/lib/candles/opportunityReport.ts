import type { WigglerProbGridConfig } from "@wiggler/lib/candles/winProbGridConfig";

/**
 * Opportunity report: how often did historical decision states reach a
 * given confidence threshold? Answers "would the model produce enough
 * tradeable signals to bother?" without requiring an order-book
 * backtest.
 *
 * For each threshold T, we sum `count` across grid buckets whose
 * `p_win_lower ≥ T`. Buckets with `count < min_bucket_count` are
 * excluded — they would not be tradeable anyway under wiggler's risk
 * defaults.
 *
 * Cell-level breakdowns (per remaining_sec, per vol_bin) help see where
 * the signal lives: usually the higher-remaining-sec / lower-vol cells
 * are where confident leads survive.
 */

export const DEFAULT_OPPORTUNITY_THRESHOLDS: readonly number[] = [
  0.7, 0.8, 0.9, 0.95, 0.98,
] as const;

export type OpportunityRow = Readonly<{
  threshold: number;
  totalSignals: number;
  /**
   * Average signals per day across the training window. May be
   * approximate when the window is shorter than 1 day.
   */
  signalsPerDay: number;
  byRemainingSec: ReadonlyArray<{ remainingSec: number; signals: number }>;
  byVolBin: ReadonlyArray<{ volBin: string; signals: number }>;
}>;

export type OpportunityReport = Readonly<{
  asset: string;
  intervalSec: number;
  anchorMode: "rolling" | "boundary";
  windowDays: number;
  /** Decision states scanned (after `min_bucket_count` filter). */
  tradableRows: number;
  rows: readonly OpportunityRow[];
}>;

export function buildOpportunityReport(args: {
  config: WigglerProbGridConfig;
  thresholds?: readonly number[];
}): OpportunityReport {
  const thresholds = args.thresholds ?? DEFAULT_OPPORTUNITY_THRESHOLDS;
  const minBucketCount = args.config.risk_defaults.min_bucket_count;

  // Filter out buckets that wiggler wouldn't trade out of regardless.
  const tradableCells = args.config.grid.filter(
    (g) => g.count >= minBucketCount,
  );
  const tradableRows = tradableCells.reduce((acc, g) => acc + g.count, 0);

  const windowMs =
    args.config.training_input.window_start_ms !== null &&
    args.config.training_input.window_end_ms !== null
      ? args.config.training_input.window_end_ms -
        args.config.training_input.window_start_ms
      : 0;
  const windowDays = windowMs > 0 ? windowMs / 86_400_000 : 1;

  const rows: OpportunityRow[] = thresholds.map((threshold) => {
    const matching = tradableCells.filter((g) => g.p_win_lower >= threshold);
    const totalSignals = matching.reduce((acc, g) => acc + g.count, 0);
    const byRemaining = sumBy(matching, (g) => g.remaining_sec).map(
      ([remainingSec, signals]) => ({
        remainingSec: Number(remainingSec),
        signals,
      }),
    );
    const byVol = sumBy(matching, (g) => g.vol_bin).map(([volBin, signals]) => ({
      volBin: String(volBin),
      signals,
    }));
    return {
      threshold,
      totalSignals,
      signalsPerDay: windowDays > 0 ? totalSignals / windowDays : 0,
      byRemainingSec: byRemaining,
      byVolBin: byVol,
    };
  });

  return {
    asset: args.config.asset,
    intervalSec: args.config.interval_sec,
    anchorMode: args.config.anchor_mode,
    windowDays,
    tradableRows,
    rows,
  };
}

function sumBy<T, K extends string | number>(
  rows: readonly T[],
  keyFn: (row: T) => K,
): Array<[K, number]> {
  const acc = new Map<K, number>();
  for (const row of rows) {
    const key = keyFn(row);
    const count = "count" in (row as object) ? (row as { count: number }).count : 0;
    acc.set(key, (acc.get(key) ?? 0) + count);
  }
  return [...acc.entries()].sort((a, b) => {
    if (typeof a[0] === "number" && typeof b[0] === "number") {
      return (a[0]) - (b[0]);
    }
    return String(a[0]).localeCompare(String(b[0]));
  });
}
