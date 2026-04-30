import type { CandleSource, Timeframe } from "@wiggler/constants/candles";
import type { DatabaseClient } from "@wiggler/lib/db/types";

/**
 * Returns the most recent `open_time_ms` we already have for the given
 * (source, symbol, timeframe), or `null` when nothing has been synced yet.
 * Used by the orchestrator to resume from where a previous sync left off
 * — re-running `candles:sync` is a no-op for already-fetched windows.
 */
export async function getLatestCandleOpenMs(
  db: DatabaseClient,
  args: Readonly<{
    source: CandleSource;
    symbol: string;
    timeframe: Timeframe;
  }>,
): Promise<number | null> {
  const row = await db
    .selectFrom("candles")
    .select((eb) => eb.fn.max("open_time_ms").as("latest"))
    .where("source", "=", args.source)
    .where("symbol", "=", args.symbol)
    .where("timeframe", "=", args.timeframe)
    .executeTakeFirst();
  if (!row || row.latest === null) {
    return null;
  }
  return Number(row.latest);
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
