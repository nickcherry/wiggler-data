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
export type DatabaseBigint = ColumnType<string, number | bigint | string, number | bigint | string>;
export type NullableDatabaseBigint = ColumnType<
  string | null,
  number | bigint | string | null | undefined,
  number | bigint | string | null
>;
export type NullableDatabaseInt = ColumnType<
  number | null,
  number | undefined | null,
  number | null
>;
export type DefaultedDatabaseTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
export type DefaultedDatabaseInt = ColumnType<number, number | undefined, number>;
export type GeneratedBigInt = ColumnType<string, never, never>;

/**
 * Canonical OHLCV row. One per `(source, symbol, timeframe, open_time)`.
 * Prices and volumes are integer 1e8 units; the timestamp is stored both
 * as `timestamptz` (for indexed range queries) and `bigint` ms (for exact
 * equality joins and pagination cursors).
 */
export interface CandlesTable {
  readonly source: string;
  readonly symbol: string;
  readonly exchange_pair: string;
  readonly timeframe: string;
  readonly open_time: DatabaseTimestamp;
  readonly open_time_ms: DatabaseBigint;
  readonly open_e8: DatabaseBigint;
  readonly high_e8: DatabaseBigint;
  readonly low_e8: DatabaseBigint;
  readonly close_e8: DatabaseBigint;
  readonly volume_e8: NullableDatabaseBigint;
  readonly trades: NullableDatabaseInt;
  readonly fetched_at: DefaultedDatabaseTimestamp;
}

/**
 * One row per `candles:sync` invocation per (source, symbol, timeframe).
 * Status is `running` while in flight, then `completed` or `failed`.
 */
export interface CandleSyncRunsTable {
  readonly id: GeneratedBigInt;
  readonly run_id: string;
  readonly source: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly from_ts: DatabaseTimestamp;
  readonly to_ts: DatabaseTimestamp;
  readonly started_at: DatabaseTimestamp;
  readonly finished_at: NullableDatabaseTimestamp;
  readonly status: string;
  readonly rows_upserted: DefaultedDatabaseInt;
  readonly error: NullableDatabaseText;
}

export interface Database {
  readonly candles: CandlesTable;
  readonly candle_sync_runs: CandleSyncRunsTable;
}

export type DatabaseClient = Kysely<Database>;
