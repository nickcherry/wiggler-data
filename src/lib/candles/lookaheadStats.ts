import type { Timeframe } from "@wiggler/constants/candles";
import type { LookaheadSource } from "@wiggler/lib/candles/lookahead";
import type { DatabaseClient } from "@wiggler/lib/db/types";
import { sql } from "kysely";

/**
 * Metrics on `candle_lookahead_features` that we summarize as
 * distributions. Order here is the order they're rendered by the CLI.
 */
export const LOOKAHEAD_METRICS = [
  "max_abs_excursion_bps",
  "close_to_close_abs_return_bps",
  "range_bps",
  "max_up_move_bps",
  "max_down_move_bps",
] as const;
export type LookaheadMetric = (typeof LOOKAHEAD_METRICS)[number];

/**
 * One-line descriptions of each metric, surfaced under the metric
 * heading in the human-readable distribution report.
 */
export const LOOKAHEAD_METRIC_DESCRIPTIONS: Readonly<
  Record<LookaheadMetric, string>
> = {
  max_abs_excursion_bps:
    "Biggest move (either direction) reached during the window. max(max_up_move_bps, max_down_move_bps).",
  close_to_close_abs_return_bps:
    "Absolute return from anchor close to end-of-window close. |10_000 × (end_price / start_price − 1)|.",
  range_bps:
    "Spread from highest high to lowest low within the window. 10_000 × (future_high / future_low − 1).",
  max_up_move_bps:
    "Biggest upward move from anchor close to highest point in the window. Signed — negative when price never rose above the anchor.",
  max_down_move_bps:
    "Biggest downward move from anchor close to lowest point in the window. Signed — negative when price never fell below the anchor.",
};

/**
 * Lightweight fingerprint of the lookahead-features data for one
 * `(symbol, timeframe)`. Used to invalidate the on-disk distribution
 * cache: if the source data changed since the cache was written, both
 * `rowCount` and `latestOpenTimeMs` will move.
 */
export type LookaheadFingerprint = Readonly<{
  rowCount: number;
  latestOpenTimeMs: number | null;
}>;

/**
 * Returns the cheap data-shape fingerprint described on
 * `LookaheadFingerprint`. The query is index-only-scan-eligible on the
 * existing `candle_lookahead_features_symbol_lookahead_idx` and runs
 * in a few milliseconds.
 */
export async function getLookaheadFingerprint(
  db: DatabaseClient,
  args: Readonly<{ symbol: string; timeframe: Timeframe }>,
): Promise<LookaheadFingerprint> {
  const result = await sql<{ cnt: string; latest_ms: string | null }>`
    SELECT
      COUNT(*)::bigint                  AS cnt,
      MAX(open_time_ms)                 AS latest_ms
    FROM candle_lookahead_features
    WHERE symbol = ${args.symbol}
      AND timeframe = ${args.timeframe}
  `.execute(db);
  const row = result.rows[0];
  return {
    rowCount: row ? Number(row.cnt) : 0,
    latestOpenTimeMs: row && row.latest_ms !== null ? Number(row.latest_ms) : null,
  };
}

/**
 * `true` when two fingerprints refer to identical data shape. Used by
 * the cache layer to decide if a previously written cache is still valid.
 */
export function fingerprintsMatch(
  a: LookaheadFingerprint,
  b: LookaheadFingerprint,
): boolean {
  return a.rowCount === b.rowCount && a.latestOpenTimeMs === b.latestOpenTimeMs;
}

/**
 * Distribution summary for one (source, lookahead) cell of one metric.
 * `count` is the row count behind the percentiles — useful for sanity
 * checking against `candle_lookahead_features` row counts and for
 * spotting under-populated cells (e.g. Bitfinex's gappy coverage).
 */
export type LookaheadStatsRow = Readonly<{
  source: LookaheadSource;
  lookaheadMin: number;
  count: number;
  mean: number;
  p50: number;
  p75: number;
  p80: number;
  p90: number;
  p95: number;
  p97_5: number;
  p99: number;
  p99_5: number;
  max: number;
}>;

export type LookaheadDistribution = Readonly<{
  metric: LookaheadMetric;
  rows: readonly LookaheadStatsRow[];
}>;

/**
 * Computes percentile distributions of every requested lookahead
 * metric, grouped by `(source, lookahead_min)`. One round-trip per
 * metric — `PERCENTILE_CONT` with multiple percentiles in a single
 * grouping is fast (one sort per group), so this stays well under a
 * second even on the full 12.7M-row table.
 *
 * Always returns rows for every source — the source filter (if any)
 * is applied client-side. This keeps the cache layer's "one file per
 * metric, all sources stored" invariant simple to reason about: the
 * raw aggregate result is invariant on the source-filter axis, so a
 * file written by one request is reusable by any other request that
 * targets the same `(symbol, timeframe, metric)`.
 */
export async function summarizeLookaheadDistributions(
  db: DatabaseClient,
  args: Readonly<{
    symbol: string;
    timeframe: Timeframe;
    metrics?: readonly LookaheadMetric[];
  }>,
): Promise<readonly LookaheadDistribution[]> {
  const metrics = args.metrics ?? LOOKAHEAD_METRICS;
  const out: LookaheadDistribution[] = [];
  for (const metric of metrics) {
    const rows = await summarizeOneMetric(db, {
      symbol: args.symbol,
      timeframe: args.timeframe,
      metric,
    });
    out.push({ metric, rows });
  }
  return out;
}

/**
 * Computes one metric's distribution rows for every source in one
 * `PERCENTILE_CONT` SQL pass. Used both by `summarizeLookaheadDistributions`
 * and by the per-metric cache layer (which stores the result of this
 * function verbatim and slices by source on read).
 */
export async function summarizeOneMetric(
  db: DatabaseClient,
  args: Readonly<{
    symbol: string;
    timeframe: Timeframe;
    metric: LookaheadMetric;
  }>,
): Promise<readonly LookaheadStatsRow[]> {
  // The metric column name comes from a const-typed enum, so it cannot
  // come from untrusted input — but we still pin it through the
  // `LOOKAHEAD_METRICS` allowlist before composing the SQL below so the
  // boundary is explicit (and so an accidental future change can't slip
  // a non-allowlisted column reference past us).
  if (!LOOKAHEAD_METRICS.includes(args.metric)) {
    throw new Error(`unsupported metric: ${args.metric}`);
  }
  const metricColumn = sql.ref(args.metric);

  const result = await sql<AggregateRow>`
    SELECT
      source,
      lookahead_min,
      COUNT(*)::bigint                                                      AS cnt,
      ROUND(AVG(${metricColumn}))                                           AS mean,
      PERCENTILE_CONT(0.500) WITHIN GROUP (ORDER BY ${metricColumn})        AS p50,
      PERCENTILE_CONT(0.750) WITHIN GROUP (ORDER BY ${metricColumn})        AS p75,
      PERCENTILE_CONT(0.800) WITHIN GROUP (ORDER BY ${metricColumn})        AS p80,
      PERCENTILE_CONT(0.900) WITHIN GROUP (ORDER BY ${metricColumn})        AS p90,
      PERCENTILE_CONT(0.950) WITHIN GROUP (ORDER BY ${metricColumn})        AS p95,
      PERCENTILE_CONT(0.975) WITHIN GROUP (ORDER BY ${metricColumn})        AS p97_5,
      PERCENTILE_CONT(0.990) WITHIN GROUP (ORDER BY ${metricColumn})        AS p99,
      PERCENTILE_CONT(0.995) WITHIN GROUP (ORDER BY ${metricColumn})        AS p99_5,
      MAX(${metricColumn})::int                                             AS max_v
    FROM candle_lookahead_features
    WHERE symbol = ${args.symbol}
      AND timeframe = ${args.timeframe}
    GROUP BY source, lookahead_min
    ORDER BY source, lookahead_min
  `.execute(db);

  return result.rows.map((row) => ({
    source: row.source as LookaheadSource,
    lookaheadMin: row.lookahead_min,
    count: Number(row.cnt),
    mean: Math.round(Number(row.mean)),
    p50: Math.round(Number(row.p50)),
    p75: Math.round(Number(row.p75)),
    p80: Math.round(Number(row.p80)),
    p90: Math.round(Number(row.p90)),
    p95: Math.round(Number(row.p95)),
    p97_5: Math.round(Number(row.p97_5)),
    p99: Math.round(Number(row.p99)),
    p99_5: Math.round(Number(row.p99_5)),
    max: row.max_v,
  }));
}

/**
 * Slices a metric's stats rows down to a requested set of sources.
 * Order of sources in the result matches `sources` (not the SQL order).
 */
export function filterStatsRowsBySources(
  rows: readonly LookaheadStatsRow[],
  sources: readonly LookaheadSource[],
): readonly LookaheadStatsRow[] {
  const sourceOrder = new Map(sources.map((s, i) => [s, i] as const));
  return rows
    .filter((row) => sourceOrder.has(row.source))
    .sort((a, b) => {
      const sa = sourceOrder.get(a.source) ?? 0;
      const sb = sourceOrder.get(b.source) ?? 0;
      if (sa !== sb) {
        return sa - sb;
      }
      return a.lookaheadMin - b.lookaheadMin;
    });
}

/**
 * Result row from the percentile-aggregation SQL. Postgres returns
 * `count` as bigint-as-string and the percentile / mean values as
 * `numeric` strings since the underlying column is integer-typed.
 */
type AggregateRow = Readonly<{
  source: string;
  lookahead_min: number;
  cnt: string;
  mean: string;
  p50: string;
  p75: string;
  p80: string;
  p90: string;
  p95: string;
  p97_5: string;
  p99: string;
  p99_5: string;
  max_v: number;
}>;
