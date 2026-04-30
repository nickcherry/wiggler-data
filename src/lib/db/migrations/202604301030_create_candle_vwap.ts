import type { Database } from "@wiggler/lib/db/types";
import { type Kysely, sql } from "kysely";

/**
 * Cross-source VWAP per `(symbol, timeframe, open_time)`.
 *
 * For every minute (or whatever timeframe) where at least one source has a
 * candle, we materialize a single fused price:
 *
 *     vwap_e8 = Σ((high+low+close)/3 × volume)  /  Σ volume
 *
 * across the up-to-4 sources we sync. This gives the model one canonical
 * volume-weighted price per timestamp, with high-volume venues pulling
 * harder than thin ones (a 0.0002 BTC Binance.US print contributes ~2700×
 * less weight than a 0.59 BTC Coinbase print at the same minute).
 *
 * `total_volume_e8` is the sum of the volumes that contributed to the
 * weighted average — useful as both an audit trail and a feature in its
 * own right (regime-of-liquidity signal). `source_count` is how many of
 * the up-to-4 sources had a candle for that minute.
 *
 * The PK on `(symbol, timeframe, open_time)` handles both upsert
 * idempotency and time-ordered scans during training data extraction.
 * No secondary index needed up front.
 *
 * Read pattern on the source `candles` table is already covered by the
 * existing `candles_symbol_time_idx (symbol, timeframe, open_time)` —
 * verified via EXPLAIN to use an Index Scan with no sort/heap fetch
 * pathology, so we don't add a new index there either.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("candle_vwap")
    .addColumn("symbol", "text", (column) => column.notNull())
    .addColumn("timeframe", "text", (column) => column.notNull())
    .addColumn("open_time", "timestamptz", (column) => column.notNull())
    .addColumn("open_time_ms", "bigint", (column) => column.notNull())
    .addColumn("vwap_e8", "bigint", (column) => column.notNull())
    .addColumn("total_volume_e8", "bigint", (column) => column.notNull())
    .addColumn("source_count", "smallint", (column) => column.notNull())
    .addColumn("computed_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("candle_vwap_pkey", [
      "symbol",
      "timeframe",
      "open_time",
    ])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("candle_vwap").ifExists().execute();
}
