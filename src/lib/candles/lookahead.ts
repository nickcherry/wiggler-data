import {
  CANDLE_SOURCES,
  type CandleSource,
  type Timeframe,
  TIMEFRAME_MS,
} from "@wiggler/constants/candles";
import type { DatabaseClient } from "@wiggler/lib/db/types";
import { logger } from "@wiggler/lib/logging/logger";
import { sql } from "kysely";

/**
 * Sources we materialize lookahead features for. Includes every CEX
 * source we sync raw candles from, plus the synthetic `vwap` source
 * which reads from `candle_vwap` (the cross-source aggregate).
 */
export const LOOKAHEAD_SOURCES = [...CANDLE_SOURCES, "vwap"] as const;
export type LookaheadSource = (typeof LOOKAHEAD_SOURCES)[number];

/**
 * Lookahead horizons in minutes. The lib supports any positive integer
 * here; we materialize 1..5 by default per the product spec.
 */
export const LOOKAHEAD_MINUTES = [1, 2, 3, 4, 5] as const;
export type LookaheadMinutes = (typeof LOOKAHEAD_MINUTES)[number];

/**
 * Maximum rows per single INSERT into `candle_lookahead_features`. 16
 * columns × 4_000 rows = 64K bind params, just under Postgres's
 * 65_535-bind cap.
 */
const UPSERT_CHUNK_SIZE = 4_000;

/**
 * Normalized series row used by the sliding-pointer pass. For per-CEX
 * sources, `startPriceE8` is the candle's close, `highE8`/`lowE8` are
 * the wick extremes. For the `vwap` variant, all three fields collapse
 * to the single `vwap_e8` value (since cross-source VWAP doesn't carry
 * intra-bucket wicks).
 */
type SeriesRow = Readonly<{
  openTimeMs: number;
  openTime: Date;
  startPriceE8: bigint;
  highE8: bigint;
  lowE8: bigint;
}>;

export type LookaheadFeatureRow = Readonly<{
  source: LookaheadSource;
  symbol: string;
  timeframe: Timeframe;
  openTime: Date;
  openTimeMs: number;
  lookaheadMin: number;
  startPriceE8: bigint;
  futureHighE8: bigint;
  futureLowE8: bigint;
  endPriceE8: bigint;
  maxUpMoveBps: number;
  maxDownMoveBps: number;
  maxAbsExcursionBps: number;
  closeToCloseAbsReturnBps: number;
  rangeBps: number;
}>;

export type LookaheadSeriesResult = Readonly<{
  source: LookaheadSource;
  symbol: string;
  timeframe: Timeframe;
  fromMs: number;
  toMs: number;
  rowsComputed: number;
  rowsUpserted: number;
  status: "completed" | "failed";
  error?: string;
}>;

/**
 * `10_000 * (a/b - 1)` rounded to nearest signed int, exact in bigint.
 *
 * Implemented as `10_000 * (a - b) / b` with round-half-away-from-zero
 * to keep precision at e8 scale (where `a*10_000` can exceed the
 * Number safe-integer range for BTC-like prices).
 *
 * `b` must be > 0; callers verify this before calling.
 */
export function bpsChange(a: bigint, b: bigint): number {
  const num = (a - b) * 10_000n;
  const halfB = b / 2n;
  const rounded = num >= 0n ? (num + halfB) / b : (num - halfB) / b;
  return Number(rounded);
}

/**
 * Walks one (source, symbol, timeframe) series in time order and yields
 * lookahead-feature rows for every anchor in `[fromMs, toMs)` that has
 * at least one row in its lookahead window.
 *
 * Implementation note: a sliding pointer makes this an O(N * 5) total
 * pass rather than O(N * 5 * window_rows). Within each anchor, the
 * window expands monotonically across lookaheads (1m → 5m), so we
 * track running max/min as we extend rather than restarting.
 *
 * Exposed as a generator so the caller can pipe directly into chunked
 * upserts and never holds all 2.6M rows of one series in memory.
 */
export function* generateLookaheadFeatures(
  rows: readonly SeriesRow[],
  args: Readonly<{
    source: LookaheadSource;
    symbol: string;
    timeframe: Timeframe;
    fromMs: number;
    toMs: number;
    intervalMs: number;
    lookaheadMinutes: readonly number[];
  }>,
): Generator<LookaheadFeatureRow> {
  for (let i = 0; i < rows.length; i++) {
    const anchor = rows[i]!;
    if (anchor.openTimeMs < args.fromMs || anchor.openTimeMs >= args.toMs) {
      continue;
    }

    const startPrice = anchor.startPriceE8;
    if (startPrice <= 0n) {
      // Defensive: `bpsChange` divides by `b`, which has to be positive.
      // A zero or negative price is malformed input — skip the anchor.
      continue;
    }

    let highE8: bigint | null = null;
    let lowE8: bigint | null = null;
    let endPrice: bigint | null = null;
    let scanIdx = i + 1;

    for (const lookaheadMin of args.lookaheadMinutes) {
      const windowEndMs = anchor.openTimeMs + lookaheadMin * args.intervalMs;
      while (scanIdx < rows.length && rows[scanIdx]!.openTimeMs <= windowEndMs) {
        const next = rows[scanIdx]!;
        if (highE8 === null || next.highE8 > highE8) {
          highE8 = next.highE8;
        }
        if (lowE8 === null || next.lowE8 < lowE8) {
          lowE8 = next.lowE8;
        }
        endPrice = next.startPriceE8;
        scanIdx++;
      }

      if (highE8 === null || lowE8 === null || endPrice === null) {
        continue;
      }
      if (lowE8 <= 0n) {
        continue;
      }

      const maxUpMoveBps = bpsChange(highE8, startPrice);
      const maxDownMoveBps = bpsChange(startPrice, lowE8);
      const closeToCloseAbsReturnBps = Math.abs(
        bpsChange(endPrice, startPrice),
      );
      const rangeBps = bpsChange(highE8, lowE8);
      const maxAbsExcursionBps = Math.max(maxUpMoveBps, maxDownMoveBps);

      yield {
        source: args.source,
        symbol: args.symbol,
        timeframe: args.timeframe,
        openTime: anchor.openTime,
        openTimeMs: anchor.openTimeMs,
        lookaheadMin,
        startPriceE8: startPrice,
        futureHighE8: highE8,
        futureLowE8: lowE8,
        endPriceE8: endPrice,
        maxUpMoveBps,
        maxDownMoveBps,
        maxAbsExcursionBps,
        closeToCloseAbsReturnBps,
        rangeBps,
      };
    }
  }
}

/**
 * Computes lookahead features for one (source, symbol, timeframe) over
 * `[fromMs, toMs)` and upserts them into `candle_lookahead_features`.
 *
 * Reads the source data once (with the largest lookahead window's worth
 * of headroom past `toMs` so anchors near the boundary still get a full
 * lookahead) and streams the generator into chunked upserts.
 */
export async function computeLookaheadSeries(
  db: DatabaseClient,
  args: Readonly<{
    source: LookaheadSource;
    symbol: string;
    timeframe: Timeframe;
    fromMs: number;
    toMs: number;
    lookaheadMinutes?: readonly number[];
  }>,
): Promise<LookaheadSeriesResult> {
  const log = logger.child({
    component: "candles_lookahead",
    source: args.source,
    symbol: args.symbol,
    timeframe: args.timeframe,
  });
  const lookaheadMinutes = args.lookaheadMinutes ?? LOOKAHEAD_MINUTES;
  const intervalMs = TIMEFRAME_MS[args.timeframe];
  const maxLookaheadMs =
    Math.max(...lookaheadMinutes, 0) * intervalMs;

  log.info("lookahead compute started", {
    fromMs: args.fromMs,
    toMs: args.toMs,
    lookaheadMinutes,
  });

  try {
    const rows = await loadSeriesRows(db, {
      source: args.source,
      symbol: args.symbol,
      timeframe: args.timeframe,
      // Read past `toMs` by the largest lookahead so we have future data
      // for anchors at the right edge.
      fromMs: args.fromMs,
      toMs: args.toMs + maxLookaheadMs,
    });
    log.info("lookahead source rows loaded", { count: rows.length });

    let rowsComputed = 0;
    let rowsUpserted = 0;
    let buffer: LookaheadFeatureRow[] = [];
    let lastLogAtCount = 0;

    for (const row of generateLookaheadFeatures(rows, {
      source: args.source,
      symbol: args.symbol,
      timeframe: args.timeframe,
      fromMs: args.fromMs,
      toMs: args.toMs,
      intervalMs,
      lookaheadMinutes,
    })) {
      buffer.push(row);
      rowsComputed++;
      if (buffer.length >= UPSERT_CHUNK_SIZE) {
        rowsUpserted += await upsertLookaheadChunk(db, buffer);
        buffer = [];
        if (rowsUpserted - lastLogAtCount >= 250_000) {
          log.info("lookahead upsert progress", { rowsUpserted });
          lastLogAtCount = rowsUpserted;
        }
      }
    }
    if (buffer.length > 0) {
      rowsUpserted += await upsertLookaheadChunk(db, buffer);
    }

    log.info("lookahead compute completed", { rowsComputed, rowsUpserted });
    return {
      source: args.source,
      symbol: args.symbol,
      timeframe: args.timeframe,
      fromMs: args.fromMs,
      toMs: args.toMs,
      rowsComputed,
      rowsUpserted,
      status: "completed",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("lookahead compute failed", { message });
    return {
      source: args.source,
      symbol: args.symbol,
      timeframe: args.timeframe,
      fromMs: args.fromMs,
      toMs: args.toMs,
      rowsComputed: 0,
      rowsUpserted: 0,
      status: "failed",
      error: message,
    };
  }
}

/**
 * Fan-out wrapper: runs `computeLookaheadSeries` for every requested
 * (source, symbol) pair in parallel. Each invocation is independent and
 * entirely DB-bound.
 */
export async function computeManyLookaheadSeries(
  db: DatabaseClient,
  args: Readonly<{
    sources: readonly LookaheadSource[];
    symbols: readonly string[];
    timeframe: Timeframe;
    fromMs: number;
    toMs: number;
    lookaheadMinutes?: readonly number[];
  }>,
): Promise<readonly LookaheadSeriesResult[]> {
  const tasks: Array<Promise<LookaheadSeriesResult>> = [];
  for (const source of args.sources) {
    for (const symbol of args.symbols) {
      tasks.push(
        computeLookaheadSeries(db, {
          source,
          symbol,
          timeframe: args.timeframe,
          fromMs: args.fromMs,
          toMs: args.toMs,
          lookaheadMinutes: args.lookaheadMinutes,
        }),
      );
    }
  }
  return Promise.all(tasks);
}

async function loadSeriesRows(
  db: DatabaseClient,
  args: Readonly<{
    source: LookaheadSource;
    symbol: string;
    timeframe: Timeframe;
    fromMs: number;
    toMs: number;
  }>,
): Promise<readonly SeriesRow[]> {
  if (args.source === "vwap") {
    const result = await db
      .selectFrom("candle_vwap")
      .select(["open_time", "open_time_ms", "vwap_e8"])
      .where("symbol", "=", args.symbol)
      .where("timeframe", "=", args.timeframe)
      .where("open_time", ">=", new Date(args.fromMs))
      .where("open_time", "<", new Date(args.toMs))
      .orderBy("open_time", "asc")
      .execute();
    return result.map((row) => {
      const vwap = BigInt(row.vwap_e8);
      return {
        openTimeMs: Number(row.open_time_ms),
        openTime: row.open_time,
        startPriceE8: vwap,
        highE8: vwap,
        lowE8: vwap,
      };
    });
  }

  const source: CandleSource = args.source;
  const result = await db
    .selectFrom("candles")
    .select(["open_time", "open_time_ms", "close_e8", "high_e8", "low_e8"])
    .where("source", "=", source)
    .where("symbol", "=", args.symbol)
    .where("timeframe", "=", args.timeframe)
    .where("open_time", ">=", new Date(args.fromMs))
    .where("open_time", "<", new Date(args.toMs))
    .orderBy("open_time", "asc")
    .execute();
  return result.map((row) => ({
    openTimeMs: Number(row.open_time_ms),
    openTime: row.open_time,
    startPriceE8: BigInt(row.close_e8),
    highE8: BigInt(row.high_e8),
    lowE8: BigInt(row.low_e8),
  }));
}

async function upsertLookaheadChunk(
  db: DatabaseClient,
  rows: readonly LookaheadFeatureRow[],
): Promise<number> {
  const values = rows.map((r) => ({
    source: r.source,
    symbol: r.symbol,
    timeframe: r.timeframe,
    open_time: r.openTime,
    open_time_ms: r.openTimeMs.toString(),
    lookahead_min: r.lookaheadMin,
    start_price_e8: r.startPriceE8.toString(),
    future_high_e8: r.futureHighE8.toString(),
    future_low_e8: r.futureLowE8.toString(),
    end_price_e8: r.endPriceE8.toString(),
    max_up_move_bps: r.maxUpMoveBps,
    max_down_move_bps: r.maxDownMoveBps,
    max_abs_excursion_bps: r.maxAbsExcursionBps,
    close_to_close_abs_return_bps: r.closeToCloseAbsReturnBps,
    range_bps: r.rangeBps,
  }));
  await db
    .insertInto("candle_lookahead_features")
    .values(values)
    .onConflict((oc) =>
      oc
        .columns(["source", "symbol", "timeframe", "open_time", "lookahead_min"])
        .doUpdateSet({
          open_time_ms: (eb) => eb.ref("excluded.open_time_ms"),
          start_price_e8: (eb) => eb.ref("excluded.start_price_e8"),
          future_high_e8: (eb) => eb.ref("excluded.future_high_e8"),
          future_low_e8: (eb) => eb.ref("excluded.future_low_e8"),
          end_price_e8: (eb) => eb.ref("excluded.end_price_e8"),
          max_up_move_bps: (eb) => eb.ref("excluded.max_up_move_bps"),
          max_down_move_bps: (eb) => eb.ref("excluded.max_down_move_bps"),
          max_abs_excursion_bps: (eb) =>
            eb.ref("excluded.max_abs_excursion_bps"),
          close_to_close_abs_return_bps: (eb) =>
            eb.ref("excluded.close_to_close_abs_return_bps"),
          range_bps: (eb) => eb.ref("excluded.range_bps"),
          computed_at: sql`now()`,
        }),
    )
    .execute();
  return values.length;
}
