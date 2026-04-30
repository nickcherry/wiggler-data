import type { CandleSource, Timeframe } from "@wiggler/constants/candles";
import type { DatabaseClient } from "@wiggler/lib/db/types";

/**
 * Records a `candle_sync_runs` row at the start of a per-(source, symbol,
 * timeframe) sync. Status is `running` until the caller flips it via
 * `finishCandleSyncRun`.
 */
export async function startCandleSyncRun(
  db: DatabaseClient,
  args: Readonly<{
    runId: string;
    source: CandleSource;
    symbol: string;
    timeframe: Timeframe;
    fromMs: number;
    toMs: number;
  }>,
): Promise<void> {
  await db
    .insertInto("candle_sync_runs")
    .values({
      run_id: args.runId,
      source: args.source,
      symbol: args.symbol,
      timeframe: args.timeframe,
      from_ts: new Date(args.fromMs),
      to_ts: new Date(args.toMs),
      started_at: new Date(),
      status: "running",
    })
    .execute();
}

/**
 * Marks a `candle_sync_runs` row terminal and records how many rows the
 * sync upserted.
 */
export async function finishCandleSyncRun(
  db: DatabaseClient,
  args: Readonly<{
    runId: string;
    status: "completed" | "failed";
    rowsUpserted: number;
    error?: string | null;
  }>,
): Promise<void> {
  await db
    .updateTable("candle_sync_runs")
    .set({
      finished_at: new Date(),
      status: args.status,
      rows_upserted: args.rowsUpserted,
      error: args.error ?? null,
    })
    .where("run_id", "=", args.runId)
    .execute();
}
