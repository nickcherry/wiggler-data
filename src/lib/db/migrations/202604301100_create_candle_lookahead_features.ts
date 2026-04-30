import type { Database } from "@wiggler/lib/db/types";
import { type Kysely, sql } from "kysely";

/**
 * Forward-looking label / feature rows: for every candle of every
 * source (the four CEX sources plus the cross-source `vwap` aggregate),
 * for every lookahead horizon in {1m, 2m, 3m, 4m, 5m}, materialize what
 * actually happened in the next N minutes.
 *
 * Per-row metrics, all in basis points (`10_000 = 1.0%`):
 *
 *   max_up_move_bps               = 10_000 * (future_high / start_price - 1)
 *   max_down_move_bps             = 10_000 * (start_price / future_low - 1)
 *   max_abs_excursion_bps         = max(max_up_move_bps, max_down_move_bps)
 *   close_to_close_abs_return_bps = abs(10_000 * (end_price / start_price - 1))
 *   range_bps                     = 10_000 * (future_high / future_low - 1)
 *
 * The four raw-price inputs are also stored so consumers can verify the
 * math, swap in alternative formulas, or train on raw price gradients
 * without round-tripping back to `candles` / `candle_vwap`.
 *
 * Lookahead semantics: for an anchor at time T, the future window is
 * `(T, T+N*60s]`. `start_price` is the anchor's close (or VWAP);
 * `future_high` / `future_low` are max/min over the window's highs and
 * lows (or the up-to-N VWAP values for the `vwap` variant);
 * `end_price` is the close (or VWAP) of the LAST row inside the window.
 * Using "last row in the window" rather than "row at exactly T+N" keeps
 * the labels well-defined when a source has gaps (Bitfinex's coverage
 * is ~87% — frequent gaps would otherwise null out 13% of the labels).
 *
 * The `source` column accepts the four CEX sources we ingest plus the
 * synthetic `'vwap'` value, which represents the cross-source
 * volume-weighted aggregate from `candle_vwap`. This keeps all label
 * variants in a single table and a single PK shape.
 *
 * Indexes:
 *   - PK `(source, symbol, timeframe, open_time, lookahead_min)` covers
 *     idempotent upserts and per-(source, series) time-ordered scans —
 *     the most common training-data extraction pattern.
 *   - Secondary `(symbol, timeframe, lookahead_min, open_time)` covers
 *     the cross-source query: "all lookahead-=N labels for BTC across
 *     every variant, ordered by time" — useful for joining the five
 *     variants side-by-side at a fixed horizon.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("candle_lookahead_features")
    .addColumn("source", "text", (column) => column.notNull())
    .addColumn("symbol", "text", (column) => column.notNull())
    .addColumn("timeframe", "text", (column) => column.notNull())
    .addColumn("open_time", "timestamptz", (column) => column.notNull())
    .addColumn("open_time_ms", "bigint", (column) => column.notNull())
    .addColumn("lookahead_min", "smallint", (column) => column.notNull())
    .addColumn("start_price_e8", "bigint", (column) => column.notNull())
    .addColumn("future_high_e8", "bigint", (column) => column.notNull())
    .addColumn("future_low_e8", "bigint", (column) => column.notNull())
    .addColumn("end_price_e8", "bigint", (column) => column.notNull())
    .addColumn("max_up_move_bps", "integer", (column) => column.notNull())
    .addColumn("max_down_move_bps", "integer", (column) => column.notNull())
    .addColumn("max_abs_excursion_bps", "integer", (column) => column.notNull())
    .addColumn("close_to_close_abs_return_bps", "integer", (column) =>
      column.notNull(),
    )
    .addColumn("range_bps", "integer", (column) => column.notNull())
    .addColumn("computed_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("candle_lookahead_features_pkey", [
      "source",
      "symbol",
      "timeframe",
      "open_time",
      "lookahead_min",
    ])
    .execute();

  await db.schema
    .createIndex("candle_lookahead_features_symbol_lookahead_idx")
    .on("candle_lookahead_features")
    .columns(["symbol", "timeframe", "lookahead_min", "open_time"])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("candle_lookahead_features").ifExists().execute();
}
