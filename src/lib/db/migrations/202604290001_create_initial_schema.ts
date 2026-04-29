import type { Database } from "@wiggler/lib/db/types";
import { type Kysely, sql } from "kysely";

/**
 * Creates the initial wiggler schema: markets, raw Polymarket WS events,
 * book snapshots/levels, trades, CEX price ticks, and collector run/heartbeat
 * tracking.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("markets")
    .addColumn("id", "bigserial", (column) => column.notNull().primaryKey())
    .addColumn("asset_symbol", "text", (column) => column.notNull())
    .addColumn("slug", "text", (column) => column.notNull().unique())
    .addColumn("event_id", "text")
    .addColumn("market_id", "text")
    .addColumn("condition_id", "text")
    .addColumn("question", "text")
    .addColumn("title", "text")
    .addColumn("start_ts", "timestamptz", (column) => column.notNull())
    .addColumn("end_ts", "timestamptz", (column) => column.notNull())
    .addColumn("up_token_id", "text")
    .addColumn("down_token_id", "text")
    .addColumn("resolution_source", "text")
    .addColumn("price_to_beat_e8", "bigint")
    .addColumn("active", "boolean")
    .addColumn("closed", "boolean")
    .addColumn("archived", "boolean")
    .addColumn("resolved", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("resolved_outcome", "text")
    .addColumn("raw_gamma", "jsonb", (column) => column.notNull())
    .addColumn("first_seen_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("last_seen_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("markets_asset_start_idx")
    .on("markets")
    .columns(["asset_symbol", "start_ts"])
    .execute();
  await db.schema
    .createIndex("markets_condition_id_idx")
    .on("markets")
    .columns(["condition_id"])
    .execute();
  await db.schema
    .createIndex("markets_window_idx")
    .on("markets")
    .columns(["start_ts", "end_ts"])
    .execute();

  await db.schema
    .createTable("polymarket_ws_events")
    .addColumn("id", "bigserial", (column) => column.notNull().primaryKey())
    .addColumn("received_at", "timestamptz", (column) => column.notNull())
    .addColumn("received_at_ms", "bigint", (column) => column.notNull())
    .addColumn("event_type", "text", (column) => column.notNull())
    .addColumn("market", "text")
    .addColumn("asset_id", "text")
    .addColumn("condition_id", "text")
    .addColumn("event_timestamp_ms", "bigint")
    .addColumn("raw", "jsonb", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("polymarket_ws_events_received_idx")
    .on("polymarket_ws_events")
    .columns(["received_at"])
    .execute();
  await db.schema
    .createIndex("polymarket_ws_events_market_idx")
    .on("polymarket_ws_events")
    .columns(["market"])
    .execute();
  await db.schema
    .createIndex("polymarket_ws_events_asset_idx")
    .on("polymarket_ws_events")
    .columns(["asset_id"])
    .execute();
  await db.schema
    .createIndex("polymarket_ws_events_type_idx")
    .on("polymarket_ws_events")
    .columns(["event_type", "received_at"])
    .execute();

  await db.schema
    .createTable("book_snapshots")
    .addColumn("id", "bigserial", (column) => column.notNull().primaryKey())
    .addColumn("captured_at", "timestamptz", (column) => column.notNull())
    .addColumn("captured_at_ms", "bigint", (column) => column.notNull())
    .addColumn("market_slug", "text", (column) => column.notNull())
    .addColumn("condition_id", "text")
    .addColumn("asset_id", "text", (column) => column.notNull())
    .addColumn("outcome", "text", (column) => column.notNull())
    .addColumn("best_bid_e6", "bigint")
    .addColumn("best_ask_e6", "bigint")
    .addColumn("spread_e6", "bigint")
    .addColumn("tick_size_e6", "bigint")
    .addColumn("book_hash", "text")
    .addColumn("depth_limit", "integer", (column) => column.notNull())
    .addColumn("raw_source", "text", (column) =>
      column.notNull().defaultTo("ws_reconstructed"),
    )
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await sql`
    alter table book_snapshots
    add constraint book_snapshots_market_slug_fkey
    foreign key (market_slug) references markets(slug)
    on delete restrict
    on update cascade
  `.execute(db);

  await db.schema
    .createIndex("book_snapshots_market_time_idx")
    .on("book_snapshots")
    .columns(["market_slug", "captured_at"])
    .execute();
  await db.schema
    .createIndex("book_snapshots_asset_time_idx")
    .on("book_snapshots")
    .columns(["asset_id", "captured_at"])
    .execute();

  await db.schema
    .createTable("book_levels")
    .addColumn("snapshot_id", "bigint", (column) => column.notNull())
    .addColumn("side", "text", (column) => column.notNull())
    .addColumn("level_index", "integer", (column) => column.notNull())
    .addColumn("price_e6", "bigint", (column) => column.notNull())
    .addColumn("size_e6", "bigint", (column) => column.notNull())
    .addPrimaryKeyConstraint("book_levels_pkey", ["snapshot_id", "side", "level_index"])
    .execute();

  await sql`
    alter table book_levels
    add constraint book_levels_snapshot_fkey
    foreign key (snapshot_id) references book_snapshots(id)
    on delete cascade
  `.execute(db);

  await sql`
    alter table book_levels
    add constraint book_levels_side_check
    check (side in ('bid', 'ask'))
  `.execute(db);

  await db.schema
    .createTable("polymarket_trades")
    .addColumn("id", "bigserial", (column) => column.notNull().primaryKey())
    .addColumn("received_at", "timestamptz", (column) => column.notNull())
    .addColumn("received_at_ms", "bigint", (column) => column.notNull())
    .addColumn("market_slug", "text")
    .addColumn("market", "text")
    .addColumn("asset_id", "text", (column) => column.notNull())
    .addColumn("outcome", "text")
    .addColumn("side", "text")
    .addColumn("price_e6", "bigint", (column) => column.notNull())
    .addColumn("size_e6", "bigint", (column) => column.notNull())
    .addColumn("fee_rate_bps", "integer")
    .addColumn("event_timestamp_ms", "bigint")
    .addColumn("raw", "jsonb", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("polymarket_trades_market_time_idx")
    .on("polymarket_trades")
    .columns(["market_slug", "received_at"])
    .execute();
  await db.schema
    .createIndex("polymarket_trades_asset_time_idx")
    .on("polymarket_trades")
    .columns(["asset_id", "received_at"])
    .execute();

  await db.schema
    .createTable("price_ticks")
    .addColumn("id", "bigserial", (column) => column.notNull().primaryKey())
    .addColumn("source", "text", (column) => column.notNull())
    .addColumn("symbol", "text", (column) => column.notNull())
    .addColumn("exchange_pair", "text", (column) => column.notNull())
    .addColumn("received_at", "timestamptz", (column) => column.notNull())
    .addColumn("received_at_ms", "bigint", (column) => column.notNull())
    .addColumn("event_ts", "timestamptz")
    .addColumn("event_ms", "bigint")
    .addColumn("price_e8", "bigint")
    .addColumn("bid_e8", "bigint")
    .addColumn("ask_e8", "bigint")
    .addColumn("bid_size_e8", "bigint")
    .addColumn("ask_size_e8", "bigint")
    .addColumn("sequence", "bigint")
    .addColumn("raw", "jsonb", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("price_ticks_symbol_received_idx")
    .on("price_ticks")
    .columns(["symbol", "received_at"])
    .execute();
  await db.schema
    .createIndex("price_ticks_source_received_idx")
    .on("price_ticks")
    .columns(["source", "received_at"])
    .execute();
  await db.schema
    .createIndex("price_ticks_symbol_source_received_idx")
    .on("price_ticks")
    .columns(["symbol", "source", "received_at"])
    .execute();

  await db.schema
    .createTable("collector_runs")
    .addColumn("id", "bigserial", (column) => column.notNull().primaryKey())
    .addColumn("run_id", "text", (column) => column.notNull().unique())
    .addColumn("asset_symbol", "text", (column) => column.notNull())
    .addColumn("mode", "text", (column) => column.notNull())
    .addColumn("started_at", "timestamptz", (column) => column.notNull())
    .addColumn("stopped_at", "timestamptz")
    .addColumn("status", "text", (column) => column.notNull())
    .addColumn("error", "text")
    .addColumn("config", "jsonb", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createTable("collector_heartbeats")
    .addColumn("id", "bigserial", (column) => column.notNull().primaryKey())
    .addColumn("run_id", "text", (column) => column.notNull())
    .addColumn("component", "text", (column) => column.notNull())
    .addColumn("heartbeat_at", "timestamptz", (column) => column.notNull())
    .addColumn("status", "text", (column) => column.notNull())
    .addColumn("details", "jsonb", (column) => column.notNull().defaultTo(sql`'{}'::jsonb`))
    .execute();

  await db.schema
    .createIndex("collector_heartbeats_run_component_time_idx")
    .on("collector_heartbeats")
    .columns(["run_id", "component", "heartbeat_at"])
    .execute();
}

/**
 * Drops the initial Polymarket Pulse schema.
 */
export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("collector_heartbeats").ifExists().execute();
  await db.schema.dropTable("collector_runs").ifExists().execute();
  await db.schema.dropTable("price_ticks").ifExists().execute();
  await db.schema.dropTable("polymarket_trades").ifExists().execute();
  await db.schema.dropTable("book_levels").ifExists().execute();
  await db.schema.dropTable("book_snapshots").ifExists().execute();
  await db.schema.dropTable("polymarket_ws_events").ifExists().execute();
  await db.schema.dropTable("markets").ifExists().execute();
}
