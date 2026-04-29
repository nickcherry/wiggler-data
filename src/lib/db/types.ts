import type { ColumnType, Kysely } from "kysely";

export type DatabaseTimestamp = ColumnType<Date, Date | string, Date | string>;
export type NullableDatabaseTimestamp = ColumnType<
  Date | null,
  Date | string | undefined | null,
  Date | string | null
>;
export type NullableDatabaseText = ColumnType<
  string | null,
  string | undefined | null,
  string | null
>;
export type NullableDatabaseBigint = ColumnType<
  string | null,
  number | bigint | string | null | undefined,
  number | bigint | string | null
>;
export type DatabaseBigint = ColumnType<string, number | bigint | string, number | bigint | string>;
export type DefaultedDatabaseTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
export type GeneratedBigInt = ColumnType<string, never, never>;
export type DatabaseJsonb<T = unknown> = ColumnType<T, T | string, T | string>;
export type NullableDatabaseInt = ColumnType<
  number | null,
  number | undefined | null,
  number | null
>;
export type NullableDatabaseBoolean = ColumnType<
  boolean | null,
  boolean | undefined | null,
  boolean | null
>;
export type DefaultedDatabaseBoolean = ColumnType<
  boolean,
  boolean | undefined,
  boolean
>;

export interface MarketsTable {
  readonly id: GeneratedBigInt;
  readonly asset_symbol: string;
  readonly slug: string;
  readonly event_id: NullableDatabaseText;
  readonly market_id: NullableDatabaseText;
  readonly condition_id: NullableDatabaseText;
  readonly question: NullableDatabaseText;
  readonly title: NullableDatabaseText;
  readonly start_ts: DatabaseTimestamp;
  readonly end_ts: DatabaseTimestamp;
  readonly up_token_id: NullableDatabaseText;
  readonly down_token_id: NullableDatabaseText;
  readonly resolution_source: NullableDatabaseText;
  readonly price_to_beat_e8: NullableDatabaseBigint;
  readonly active: NullableDatabaseBoolean;
  readonly closed: NullableDatabaseBoolean;
  readonly archived: NullableDatabaseBoolean;
  readonly resolved: DefaultedDatabaseBoolean;
  readonly resolved_outcome: NullableDatabaseText;
  readonly raw_gamma: DatabaseJsonb;
  readonly first_seen_at: DefaultedDatabaseTimestamp;
  readonly last_seen_at: DefaultedDatabaseTimestamp;
  readonly created_at: DefaultedDatabaseTimestamp;
  readonly updated_at: DefaultedDatabaseTimestamp;
}

export interface BookSnapshotsTable {
  readonly id: GeneratedBigInt;
  readonly captured_at: DatabaseTimestamp;
  readonly captured_at_ms: DatabaseBigint;
  readonly market_slug: string;
  readonly condition_id: NullableDatabaseText;
  readonly asset_id: string;
  readonly outcome: string;
  readonly best_bid_e6: NullableDatabaseBigint;
  readonly best_ask_e6: NullableDatabaseBigint;
  readonly spread_e6: NullableDatabaseBigint;
  readonly tick_size_e6: NullableDatabaseBigint;
  readonly book_hash: NullableDatabaseText;
  readonly depth_limit: number;
  readonly raw_source: ColumnType<string, string | undefined, string>;
  readonly created_at: DefaultedDatabaseTimestamp;
}

export interface BookLevelsTable {
  readonly snapshot_id: number | bigint | string;
  readonly side: "bid" | "ask";
  readonly level_index: number;
  readonly price_e6: DatabaseBigint;
  readonly size_e6: DatabaseBigint;
}

export interface AssetPriceSnapshotsTable {
  readonly id: GeneratedBigInt;
  readonly captured_at: DatabaseTimestamp;
  readonly captured_at_ms: DatabaseBigint;
  readonly symbol: string;
  readonly coinbase_mid_e8: NullableDatabaseBigint;
  readonly coinbase_bid_e8: NullableDatabaseBigint;
  readonly coinbase_ask_e8: NullableDatabaseBigint;
  readonly coinbase_age_ms: NullableDatabaseBigint;
  readonly binance_mid_e8: NullableDatabaseBigint;
  readonly binance_bid_e8: NullableDatabaseBigint;
  readonly binance_ask_e8: NullableDatabaseBigint;
  readonly binance_age_ms: NullableDatabaseBigint;
  readonly gemini_mid_e8: NullableDatabaseBigint;
  readonly gemini_bid_e8: NullableDatabaseBigint;
  readonly gemini_ask_e8: NullableDatabaseBigint;
  readonly gemini_age_ms: NullableDatabaseBigint;
  readonly bybit_mid_e8: NullableDatabaseBigint;
  readonly bybit_bid_e8: NullableDatabaseBigint;
  readonly bybit_ask_e8: NullableDatabaseBigint;
  readonly bybit_age_ms: NullableDatabaseBigint;
  readonly bitstamp_mid_e8: NullableDatabaseBigint;
  readonly bitstamp_bid_e8: NullableDatabaseBigint;
  readonly bitstamp_ask_e8: NullableDatabaseBigint;
  readonly bitstamp_age_ms: NullableDatabaseBigint;
  readonly bitfinex_mid_e8: NullableDatabaseBigint;
  readonly bitfinex_bid_e8: NullableDatabaseBigint;
  readonly bitfinex_ask_e8: NullableDatabaseBigint;
  readonly bitfinex_age_ms: NullableDatabaseBigint;
  readonly kraken_mid_e8: NullableDatabaseBigint;
  readonly kraken_bid_e8: NullableDatabaseBigint;
  readonly kraken_ask_e8: NullableDatabaseBigint;
  readonly kraken_age_ms: NullableDatabaseBigint;
  readonly blended_mid_e8: NullableDatabaseBigint;
  readonly source_count: number;
  readonly created_at: DefaultedDatabaseTimestamp;
}

export interface CollectorRunsTable {
  readonly id: GeneratedBigInt;
  readonly run_id: string;
  readonly asset_symbol: string;
  readonly mode: string;
  readonly started_at: DatabaseTimestamp;
  readonly stopped_at: NullableDatabaseTimestamp;
  readonly status: string;
  readonly error: NullableDatabaseText;
  readonly config: DatabaseJsonb;
  readonly created_at: DefaultedDatabaseTimestamp;
}

export interface CollectorHeartbeatsTable {
  readonly id: GeneratedBigInt;
  readonly run_id: string;
  readonly component: string;
  readonly heartbeat_at: DatabaseTimestamp;
  readonly status: string;
  readonly details: DatabaseJsonb;
}

export interface Database {
  readonly markets: MarketsTable;
  readonly book_snapshots: BookSnapshotsTable;
  readonly book_levels: BookLevelsTable;
  readonly asset_price_snapshots: AssetPriceSnapshotsTable;
  readonly collector_runs: CollectorRunsTable;
  readonly collector_heartbeats: CollectorHeartbeatsTable;
}

export type DatabaseClient = Kysely<Database>;
