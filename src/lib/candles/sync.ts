import { randomUUID } from "node:crypto";

import type { CandleSource, Timeframe } from "@wiggler/constants/candles";
import { TIMEFRAME_MS } from "@wiggler/constants/candles";
import { getCandleCoverage } from "@wiggler/lib/candles/queries";
import {
  finishCandleSyncRun,
  startCandleSyncRun,
} from "@wiggler/lib/candles/runs";
import { FETCHERS } from "@wiggler/lib/candles/sources";
import { upsertCandles } from "@wiggler/lib/candles/upsert";
import type { DatabaseClient } from "@wiggler/lib/db/types";
import { logger } from "@wiggler/lib/logging/logger";

export type SyncSeriesResult = Readonly<{
  source: CandleSource;
  symbol: string;
  timeframe: Timeframe;
  fromMs: number;
  toMs: number;
  rowsUpserted: number;
  /** True when there was nothing left to fetch — i.e. we're already current. */
  alreadyCurrent: boolean;
  status: "completed" | "failed";
  error?: string;
}>;

/**
 * Syncs one (source, symbol, timeframe) from the next missing candle up
 * to `toMs`. If we already have data for this series, the resume cursor
 * is `latest_open_time + 1 timeframe`, so re-runs only fetch new
 * candles. Pass `forceFullRange: true` to bypass the resume cursor and
 * re-fetch the full requested window.
 *
 * Idempotent at the row level: the upsert PK on
 * `(source, symbol, timeframe, open_time)` makes any duplicate writes a
 * no-op (with the latest values + a refreshed `fetched_at`).
 */
export async function syncCandleSeries(
  db: DatabaseClient,
  args: Readonly<{
    source: CandleSource;
    symbol: string;
    timeframe: Timeframe;
    fromMs: number;
    toMs: number;
    forceFullRange?: boolean;
    signal?: AbortSignal;
  }>,
): Promise<SyncSeriesResult> {
  const log = logger.child({
    component: "candles_sync",
    source: args.source,
    symbol: args.symbol,
    timeframe: args.timeframe,
  });
  const intervalMs = TIMEFRAME_MS[args.timeframe];

  let resumeFromMs = args.fromMs;
  if (!args.forceFullRange) {
    const coverage = await getCandleCoverage(db, {
      source: args.source,
      symbol: args.symbol,
      timeframe: args.timeframe,
      fromMs: args.fromMs,
      toMs: args.toMs,
    });
    if (coverage !== null) {
      // How many candles SHOULD be in the requested window if we have full
      // contiguous coverage. The 0.95 threshold below tolerates legitimate
      // small gaps (exchange downtime, holidays for some sources) without
      // mistakenly claiming "complete" when an interrupted earlier sync
      // left big holes in the middle.
      const expectedRows = Math.max(
        1,
        Math.floor((args.toMs - args.fromMs) / intervalMs),
      );
      const olderEdgeCovered = coverage.earliestMs <= args.fromMs + intervalMs;
      const noSignificantGaps = coverage.rowCount >= expectedRows * 0.95;

      if (olderEdgeCovered && noSignificantGaps) {
        // Coverage is complete enough — resume forward from one interval
        // after the latest row we have so we skip re-fetching what we
        // already know.
        resumeFromMs = Math.max(resumeFromMs, coverage.latestMs + intervalMs);
      } else {
        // Either the older edge isn't covered, or the row count is too
        // low for the window (= gaps in the middle). Refetch the full
        // requested range; the upsert PK makes the overlap with the
        // existing data a cheap no-op.
        log.info("candles backfilling — coverage incomplete", {
          earliestMs: coverage.earliestMs,
          latestMs: coverage.latestMs,
          rowCount: coverage.rowCount,
          expectedRows,
          olderEdgeCovered,
          noSignificantGaps,
          requestedFromMs: args.fromMs,
        });
      }
    }
  }

  if (resumeFromMs >= args.toMs) {
    log.info("candles already current", {
      fromMs: args.fromMs,
      resumeFromMs,
      toMs: args.toMs,
    });
    return {
      source: args.source,
      symbol: args.symbol,
      timeframe: args.timeframe,
      fromMs: args.fromMs,
      toMs: args.toMs,
      rowsUpserted: 0,
      alreadyCurrent: true,
      status: "completed",
    };
  }

  const runId = randomUUID();
  await startCandleSyncRun(db, {
    runId,
    source: args.source,
    symbol: args.symbol,
    timeframe: args.timeframe,
    fromMs: resumeFromMs,
    toMs: args.toMs,
  });
  log.info("candles sync started", {
    runId,
    fromMs: resumeFromMs,
    toMs: args.toMs,
  });

  const fetcher = FETCHERS[args.source];
  let rowsUpserted = 0;
  let lastLogAtCount = 0;
  try {
    for await (const chunk of fetcher({
      symbol: args.symbol,
      fromMs: resumeFromMs,
      toMs: args.toMs,
      timeframe: args.timeframe,
      signal: args.signal,
    })) {
      if (chunk.length === 0) {
        continue;
      }
      const written = await upsertCandles(db, chunk);
      rowsUpserted += written;
      // Heartbeat log every ~10K rows so very long runs visibly progress.
      if (rowsUpserted - lastLogAtCount >= 10_000) {
        log.info("candles sync progress", { rowsUpserted });
        lastLogAtCount = rowsUpserted;
      }
    }
    await finishCandleSyncRun(db, {
      runId,
      status: "completed",
      rowsUpserted,
    });
    log.info("candles sync completed", { runId, rowsUpserted });
    return {
      source: args.source,
      symbol: args.symbol,
      timeframe: args.timeframe,
      fromMs: args.fromMs,
      toMs: args.toMs,
      rowsUpserted,
      alreadyCurrent: false,
      status: "completed",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishCandleSyncRun(db, {
      runId,
      status: "failed",
      rowsUpserted,
      error: message,
    });
    log.error("candles sync failed", { runId, rowsUpserted, message });
    return {
      source: args.source,
      symbol: args.symbol,
      timeframe: args.timeframe,
      fromMs: args.fromMs,
      toMs: args.toMs,
      rowsUpserted,
      alreadyCurrent: false,
      status: "failed",
      error: message,
    };
  }
}

/**
 * Fan-out wrapper: runs `syncCandleSeries` for every requested
 * `(source, symbol)` pair in parallel. Each source has its own rate limit
 * so running them concurrently doesn't compound the load on any single
 * provider.
 */
export async function syncManyCandleSeries(
  db: DatabaseClient,
  args: Readonly<{
    sources: readonly CandleSource[];
    symbols: readonly string[];
    timeframe: Timeframe;
    fromMs: number;
    toMs: number;
    forceFullRange?: boolean;
    signal?: AbortSignal;
  }>,
): Promise<readonly SyncSeriesResult[]> {
  const tasks: Array<Promise<SyncSeriesResult>> = [];
  for (const source of args.sources) {
    for (const symbol of args.symbols) {
      tasks.push(
        syncCandleSeries(db, {
          source,
          symbol,
          timeframe: args.timeframe,
          fromMs: args.fromMs,
          toMs: args.toMs,
          forceFullRange: args.forceFullRange,
          signal: args.signal,
        }),
      );
    }
  }
  return Promise.all(tasks);
}
