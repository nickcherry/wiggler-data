import type { Database } from "@wiggler/lib/db/types";
import { type Kysely, sql } from "kysely";

/**
 * Switch wiggler to snapshot-only persistence:
 *
 * - Drop the per-event tables (`polymarket_ws_events`, `polymarket_trades`,
 *   `price_ticks`). The collector now keeps Polymarket book state and CEX
 *   price state in memory and only persists periodic snapshots.
 * - Add `asset_price_snapshots`: one row per scheduler tick per asset
 *   symbol, holding the latest mid/bid/ask seen on each CEX source plus a
 *   blended midpoint and per-source staleness.
 *
 * Snapshot rows in `book_snapshots` and `asset_price_snapshots` written in
 * the same scheduler tick share an identical `captured_at_ms`, so they
 * JOIN on that bigint without a separate tick table.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("polymarket_ws_events").ifExists().execute();
  await db.schema.dropTable("polymarket_trades").ifExists().execute();
  await db.schema.dropTable("price_ticks").ifExists().execute();

  await db.schema
    .createTable("asset_price_snapshots")
    .addColumn("id", "bigserial", (column) => column.notNull().primaryKey())
    .addColumn("captured_at", "timestamptz", (column) => column.notNull())
    .addColumn("captured_at_ms", "bigint", (column) => column.notNull())
    .addColumn("symbol", "text", (column) => column.notNull())
    .addColumn("coinbase_mid_e8", "bigint")
    .addColumn("coinbase_bid_e8", "bigint")
    .addColumn("coinbase_ask_e8", "bigint")
    .addColumn("coinbase_age_ms", "bigint")
    .addColumn("binance_mid_e8", "bigint")
    .addColumn("binance_bid_e8", "bigint")
    .addColumn("binance_ask_e8", "bigint")
    .addColumn("binance_age_ms", "bigint")
    .addColumn("blended_mid_e8", "bigint")
    .addColumn("source_count", "integer", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("asset_price_snapshots_symbol_time_idx")
    .on("asset_price_snapshots")
    .columns(["symbol", "captured_at"])
    .execute();
  await db.schema
    .createIndex("asset_price_snapshots_captured_ms_idx")
    .on("asset_price_snapshots")
    .columns(["captured_at_ms"])
    .execute();
}

/**
 * Reverses the snapshot-only switch by dropping `asset_price_snapshots`. The
 * dropped per-event tables are not recreated — there is no useful "down"
 * migration that restores deleted history.
 */
export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("asset_price_snapshots").ifExists().execute();
}
