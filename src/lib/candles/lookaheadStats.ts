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
 * Input filters are intersected: if `sources` or `metrics` is omitted,
 * all available values are used.
 */
export async function summarizeLookaheadDistributions(
  db: DatabaseClient,
  args: Readonly<{
    symbol: string;
    timeframe: Timeframe;
    sources?: readonly LookaheadSource[];
    metrics?: readonly LookaheadMetric[];
  }>,
): Promise<readonly LookaheadDistribution[]> {
  const metrics = args.metrics ?? LOOKAHEAD_METRICS;
  const out: LookaheadDistribution[] = [];
  for (const metric of metrics) {
    const rows = await aggregateMetric(db, {
      symbol: args.symbol,
      timeframe: args.timeframe,
      sources: args.sources,
      metric,
    });
    out.push({ metric, rows });
  }
  return out;
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

async function aggregateMetric(
  db: DatabaseClient,
  args: Readonly<{
    symbol: string;
    timeframe: Timeframe;
    sources?: readonly LookaheadSource[];
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

  // `sources` filter is optional — when omitted, return every source we
  // have lookahead data for.
  const sourcesFilter =
    args.sources && args.sources.length > 0
      ? sql`AND source IN (${sql.join(args.sources.map((s) => sql.lit(s)))})`
      : sql``;

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
      ${sourcesFilter}
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
