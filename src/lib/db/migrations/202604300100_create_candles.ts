import type { Database } from "@wiggler/lib/db/types";
import { type Kysely, sql } from "kysely";

/**
 * Initial schema: candle history.
 *
 *   - One `candles` table holds every (source, symbol, timeframe, open_time)
 *     OHLCV row. The composite primary key makes upserts trivial: rerunning
 *     `candles:sync` over an already-fetched window is a no-op.
 *   - `candle_sync_runs` is operational metadata for an in-flight or
 *     finished sync. Lets the next sync resume from the latest open_time
 *     per (source, symbol, timeframe) in O(rows) — but the query never
 *     actually needs this table to function; it's bookkeeping for audit
 *     output, not a load-bearing dependency.
 *
 * Prices and volumes are stored as integer 1e8 units (`*_e8`). REST
 * responses come back as strings; the writer parses them through the
 * `assetPriceToE8` helper so we never carry a JS `number` through the hot
 * path.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("candles")
    .addColumn("source", "text", (column) => column.notNull())
    .addColumn("symbol", "text", (column) => column.notNull())
    .addColumn("exchange_pair", "text", (column) => column.notNull())
    .addColumn("timeframe", "text", (column) => column.notNull())
    .addColumn("open_time", "timestamptz", (column) => column.notNull())
    .addColumn("open_time_ms", "bigint", (column) => column.notNull())
    .addColumn("open_e8", "bigint", (column) => column.notNull())
    .addColumn("high_e8", "bigint", (column) => column.notNull())
    .addColumn("low_e8", "bigint", (column) => column.notNull())
    .addColumn("close_e8", "bigint", (column) => column.notNull())
    .addColumn("volume_e8", "bigint")
    .addColumn("trades", "integer")
    .addColumn("fetched_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("candles_pkey", [
      "source",
      "symbol",
      "timeframe",
      "open_time",
    ])
    .execute();

  await db.schema
    .createIndex("candles_symbol_time_idx")
    .on("candles")
    .columns(["symbol", "timeframe", "open_time"])
    .execute();
  await db.schema
    .createIndex("candles_source_symbol_idx")
    .on("candles")
    .columns(["source", "symbol", "timeframe"])
    .execute();

  await db.schema
    .createTable("candle_sync_runs")
    .addColumn("id", "bigserial", (column) => column.notNull().primaryKey())
    .addColumn("run_id", "text", (column) => column.notNull().unique())
    .addColumn("source", "text", (column) => column.notNull())
    .addColumn("symbol", "text", (column) => column.notNull())
    .addColumn("timeframe", "text", (column) => column.notNull())
    .addColumn("from_ts", "timestamptz", (column) => column.notNull())
    .addColumn("to_ts", "timestamptz", (column) => column.notNull())
    .addColumn("started_at", "timestamptz", (column) => column.notNull())
    .addColumn("finished_at", "timestamptz")
    .addColumn("status", "text", (column) => column.notNull())
    .addColumn("rows_upserted", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("error", "text")
    .execute();

  await db.schema
    .createIndex("candle_sync_runs_source_started_idx")
    .on("candle_sync_runs")
    .columns(["source", "symbol", "timeframe", "started_at"])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("candle_sync_runs").ifExists().execute();
  await db.schema.dropTable("candles").ifExists().execute();
}
