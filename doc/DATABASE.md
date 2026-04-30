# Database

PostgreSQL is the only durable store. Migrations are TypeScript files in
`src/lib/db/migrations/` driven by Kysely. There is no ORM beyond Kysely's
type-safe query builder.

## Setup

```bash
createdb wiggler
bun wiggler db:migrate
bun wiggler db:status
```

`DATABASE_URL` defaults to `postgres://localhost:5432/wiggler`.

## Tables

### `candles`

Canonical OHLCV history. One row per `(source, symbol, timeframe,
open_time)` — that's the primary key, which means upserts are trivial:
re-running `candles:sync` over a window updates each row's OHLCV in place
(and refreshes `fetched_at`) instead of inserting duplicates.

Prices and volumes are stored as integer 1e8 units (`*_e8`). REST
responses come back as decimal strings; we parse them through
`assetPriceToE8` so we never carry a JS `number` through the hot path.

Timestamps are stored both as `timestamptz` (for indexed range queries
and human-readable output) and as `bigint` ms (`open_time_ms`) for exact
equality comparisons / pagination cursors.

`exchange_pair` records what we actually subscribed to on the source
(`BTC-USD` for Coinbase, `BTCUSDT` for Binance, etc.) — useful for
debugging when a fetch returns the wrong shape.

### `candle_sync_runs`

Operational metadata for `candles:sync`. One row per invocation per
`(source, symbol, timeframe)`. Tracks `from_ts`, `to_ts`, `started_at`,
`finished_at`, `status` (`running` / `completed` / `failed`),
`rows_upserted`, and any error message. Never on the hot path; pure
audit trail.

## Indexes

- `candles_pkey` (composite PK on `source, symbol, timeframe, open_time`) —
  covers every common access pattern (per-series ordered scan, per-series
  point lookup, upsert conflict target).
- `candles_symbol_time_idx (symbol, timeframe, open_time)` — for
  cross-source analysis filtered by symbol.
- `candles_source_symbol_idx (source, symbol, timeframe)` — for the
  resume cursor lookup (`MAX(open_time_ms)`).
- `candle_sync_runs_source_started_idx` — for "show me the last run for
  this series" queries.

## Scaling Conventions

- Asset prices: `*_e8` integers (1e8 scale).
- Volumes: `*_e8` integers (same scale).
- Timestamps: `timestamptz` for queryability + `*_ms` `bigint` columns
  when exact ordering / equality matters.

## Migration Rules

- One migration file per schema change. Filenames sort lexicographically
  by date prefix (`YYYYMMDDHHmm_description.ts`).
- Every migration must define `up` and `down`. `down` should drop
  everything `up` created.
- **Never modify a migration file after it has been applied to any
  database.** Kysely tracks applied migrations by filename, so an edited
  file silently no-ops on existing DBs while fresh DBs get the new shape.
  Add a new migration file instead.

## Reset Boundaries

- `db:reset --yes` truncates every wiggler-managed table. Schema is
  preserved; data is destroyed. Use during development when you want to
  re-sync from scratch.

## Querying Conventions

- Reusable queries live under `src/lib/<domain>/queries.ts`.
- Audit / status queries return small, well-typed shapes (`Readonly<{...}>`)
  and don't leak Kysely types into callers.
- Use `sql` template tags only when Kysely's builder cannot express the
  query cleanly.
