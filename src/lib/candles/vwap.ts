import type { Timeframe } from "@wiggler/constants/candles";
import type { DatabaseClient } from "@wiggler/lib/db/types";
import { logger } from "@wiggler/lib/logging/logger";
import { sql } from "kysely";

/**
 * Maximum rows per `candle_vwap` INSERT. 7 columns × 9_000 = 63K bind
 * params, comfortably under Postgres's 65_535-bind cap. The aggregate
 * for one year of 1m candles is ~525K rows, so this chunks into ~59
 * INSERTs.
 */
const UPSERT_CHUNK_SIZE = 9_000;

/**
 * One materialized cross-source VWAP row.
 */
export type VwapRow = Readonly<{
  openTimeMs: number;
  openTime: Date;
  vwapE8: bigint;
  totalVolumeE8: bigint;
  sourceCount: number;
}>;

export type VwapSeriesResult = Readonly<{
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
 * Aggregation row shape returned by the VWAP SQL. `vwap_e8` and
 * `total_volume_e8` come back as bigint-as-string; `source_count` is
 * `COUNT(*)` which Postgres returns as bigint-as-string too.
 */
type AggregateRow = Readonly<{
  open_time_ms: string;
  open_time: Date;
  vwap_e8: string;
  total_volume_e8: string;
  source_count: string;
}>;

/**
 * Computes cross-source VWAP for one (symbol, timeframe) over
 * `[fromMs, toMs]` and upserts the result into `candle_vwap`.
 *
 * For each `open_time` bucket where ≥1 source has a candle:
 *
 *     typical_price_i = (high + low + close) / 3
 *     vwap            = Σ(typical_price_i × volume_i) / Σ volume_i
 *
 * across rows where `volume_e8 IS NOT NULL AND volume_e8 > 0`. When every
 * source for the bucket has zero or null volume (rare; means literally no
 * trades at that minute on any synced exchange), falls back to the
 * unweighted mean of typical prices so the output series stays gap-free.
 * `total_volume_e8 = 0` flags the fallback for downstream consumers.
 *
 * Idempotent at the row level via the `(symbol, timeframe, open_time)`
 * primary key.
 */
export async function computeVwapSeries(
  db: DatabaseClient,
  args: Readonly<{
    symbol: string;
    timeframe: Timeframe;
    fromMs: number;
    toMs: number;
  }>,
): Promise<VwapSeriesResult> {
  const log = logger.child({
    component: "candles_vwap",
    symbol: args.symbol,
    timeframe: args.timeframe,
  });

  log.info("vwap compute started", { fromMs: args.fromMs, toMs: args.toMs });

  try {
    const rows = await aggregateCrossSourceVwap(db, args);
    log.info("vwap rows aggregated", { count: rows.length });

    if (rows.length === 0) {
      return {
        symbol: args.symbol,
        timeframe: args.timeframe,
        fromMs: args.fromMs,
        toMs: args.toMs,
        rowsComputed: 0,
        rowsUpserted: 0,
        status: "completed",
      };
    }

    let rowsUpserted = 0;
    let lastLogAtCount = 0;
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE);
      rowsUpserted += await upsertVwapChunk(db, {
        symbol: args.symbol,
        timeframe: args.timeframe,
        rows: chunk,
      });
      if (rowsUpserted - lastLogAtCount >= 100_000) {
        log.info("vwap upsert progress", { rowsUpserted });
        lastLogAtCount = rowsUpserted;
      }
    }

    log.info("vwap compute completed", { rowsUpserted });
    return {
      symbol: args.symbol,
      timeframe: args.timeframe,
      fromMs: args.fromMs,
      toMs: args.toMs,
      rowsComputed: rows.length,
      rowsUpserted,
      status: "completed",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("vwap compute failed", { message });
    return {
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
 * Fan-out wrapper: computes VWAP for every requested symbol in parallel.
 * Each per-symbol query is independent and entirely DB-bound, so running
 * them concurrently just lets Postgres pipeline the aggregations.
 */
export async function computeManyVwapSeries(
  db: DatabaseClient,
  args: Readonly<{
    symbols: readonly string[];
    timeframe: Timeframe;
    fromMs: number;
    toMs: number;
  }>,
): Promise<readonly VwapSeriesResult[]> {
  return Promise.all(
    args.symbols.map((symbol) =>
      computeVwapSeries(db, {
        symbol,
        timeframe: args.timeframe,
        fromMs: args.fromMs,
        toMs: args.toMs,
      }),
    ),
  );
}

/**
 * Runs the cross-source aggregate in a single SQL pass. We use `numeric`
 * for the (price × volume) intermediate because price_e8 × volume_e8 can
 * exceed bigint range (e.g. 200K × 1e8 × 1000 × 1e8 ≈ 2e24). The final
 * result is rounded back to bigint inside Postgres so the app code never
 * sees a fractional price.
 */
async function aggregateCrossSourceVwap(
  db: DatabaseClient,
  args: Readonly<{
    symbol: string;
    timeframe: Timeframe;
    fromMs: number;
    toMs: number;
  }>,
): Promise<readonly VwapRow[]> {
  const result = await sql<AggregateRow>`
    SELECT
      open_time_ms,
      open_time,
      CASE
        WHEN SUM(CASE WHEN volume_e8 IS NOT NULL AND volume_e8 > 0 THEN volume_e8::numeric ELSE 0 END) > 0 THEN
          ROUND(
            SUM(CASE WHEN volume_e8 IS NOT NULL AND volume_e8 > 0
                THEN ((high_e8 + low_e8 + close_e8)::numeric / 3) * volume_e8::numeric
                ELSE 0 END)
            /
            SUM(CASE WHEN volume_e8 IS NOT NULL AND volume_e8 > 0 THEN volume_e8::numeric ELSE 0 END)
          )::bigint
        ELSE
          ROUND(AVG((high_e8 + low_e8 + close_e8)::numeric / 3))::bigint
      END AS vwap_e8,
      COALESCE(
        SUM(CASE WHEN volume_e8 IS NOT NULL AND volume_e8 > 0 THEN volume_e8 ELSE 0 END),
        0
      )::bigint AS total_volume_e8,
      COUNT(*)::bigint AS source_count
    FROM candles
    WHERE symbol = ${args.symbol}
      AND timeframe = ${args.timeframe}
      AND open_time >= ${new Date(args.fromMs)}
      AND open_time <  ${new Date(args.toMs)}
    GROUP BY open_time_ms, open_time
    ORDER BY open_time
  `.execute(db);

  return result.rows.map((row) => ({
    openTimeMs: Number(row.open_time_ms),
    openTime: row.open_time,
    vwapE8: BigInt(row.vwap_e8),
    totalVolumeE8: BigInt(row.total_volume_e8),
    sourceCount: Number(row.source_count),
  }));
}

async function upsertVwapChunk(
  db: DatabaseClient,
  args: Readonly<{
    symbol: string;
    timeframe: Timeframe;
    rows: readonly VwapRow[];
  }>,
): Promise<number> {
  const values = args.rows.map((r) => ({
    symbol: args.symbol,
    timeframe: args.timeframe,
    open_time: r.openTime,
    open_time_ms: r.openTimeMs.toString(),
    vwap_e8: r.vwapE8.toString(),
    total_volume_e8: r.totalVolumeE8.toString(),
    source_count: r.sourceCount,
  }));
  await db
    .insertInto("candle_vwap")
    .values(values)
    .onConflict((oc) =>
      oc.columns(["symbol", "timeframe", "open_time"]).doUpdateSet({
        open_time_ms: (eb) => eb.ref("excluded.open_time_ms"),
        vwap_e8: (eb) => eb.ref("excluded.vwap_e8"),
        total_volume_e8: (eb) => eb.ref("excluded.total_volume_e8"),
        source_count: (eb) => eb.ref("excluded.source_count"),
        computed_at: sql`now()`,
      }),
    )
    .execute();
  return values.length;
}
