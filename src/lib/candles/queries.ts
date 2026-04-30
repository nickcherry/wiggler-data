import type { CandleSource, Timeframe } from "@wiggler/constants/candles";
import type { DatabaseClient } from "@wiggler/lib/db/types";

/**
 * Coverage statistics for a (source, symbol, timeframe) inside a specific
 * `[fromMs, toMs]` window. `rowCount` is the number of candles we already
 * have whose `open_time_ms` falls in that window — used to detect gaps
 * left by an interrupted earlier sync. Returns `null` when nothing has
 * been synced yet for the series.
 */
export type CandleCoverage = Readonly<{
  earliestMs: number;
  latestMs: number;
  rowCount: number;
}>;

/**
 * Returns coverage stats inside `[fromMs, toMs]` for the given series, or
 * `null` when there are no rows yet. Used by the orchestrator to decide
 * whether to resume forward or to refetch.
 *
 * Crucial: it's not enough to look only at `min`/`max`. An interrupted
 * earlier sync can leave the right `min` and `max` (the very first and
 * very last candle managed to commit) while the middle is full of holes.
 * Comparing `rowCount` against the expected count for the window is what
 * catches that case.
 */
export async function getCandleCoverage(
  db: DatabaseClient,
  args: Readonly<{
    source: CandleSource;
    symbol: string;
    timeframe: Timeframe;
    fromMs: number;
    toMs: number;
  }>,
): Promise<CandleCoverage | null> {
  const row = await db
    .selectFrom("candles")
    .select((eb) => [
      eb.fn.min("open_time_ms").as("earliest"),
      eb.fn.max("open_time_ms").as("latest"),
      eb.fn.countAll<string>().as("rows"),
    ])
    .where("source", "=", args.source)
    .where("symbol", "=", args.symbol)
    .where("timeframe", "=", args.timeframe)
    .where("open_time_ms", ">=", args.fromMs.toString())
    .where("open_time_ms", "<", args.toMs.toString())
    .executeTakeFirst();
  if (!row || row.earliest === null || row.latest === null) {
    return null;
  }
  return {
    earliestMs: Number(row.earliest),
    latestMs: Number(row.latest),
    rowCount: Number(row.rows ?? 0),
  };
}

export type CandleStatusRow = Readonly<{
  source: string;
  symbol: string;
  timeframe: string;
  total: number;
  earliestMs: number | null;
  latestMs: number | null;
}>;

/**
 * Per-(source, symbol, timeframe) coverage summary used by `candles:status`.
 */
export async function summarizeCandleCoverage(
  db: DatabaseClient,
): Promise<readonly CandleStatusRow[]> {
  const rows = await db
    .selectFrom("candles")
    .select((eb) => [
      "source",
      "symbol",
      "timeframe",
      eb.fn.countAll<string>().as("total"),
      eb.fn.min("open_time_ms").as("earliest"),
      eb.fn.max("open_time_ms").as("latest"),
    ])
    .groupBy(["source", "symbol", "timeframe"])
    .orderBy("symbol", "asc")
    .orderBy("source", "asc")
    .orderBy("timeframe", "asc")
    .execute();
  return rows.map((r) => ({
    source: r.source,
    symbol: r.symbol,
    timeframe: r.timeframe,
    total: Number(r.total ?? 0),
    earliestMs: r.earliest !== null ? Number(r.earliest) : null,
    latestMs: r.latest !== null ? Number(r.latest) : null,
  }));
}
