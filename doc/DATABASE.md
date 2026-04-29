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

## Storage Model

wiggler uses **snapshot-only persistence**. Polymarket WS frames update an
in-memory `BookState` per CLOB asset id; CEX WS ticks update an in-memory
`CexPriceRegistry` per `(source, symbol)`. Once per
`COLLECTOR_SNAPSHOT_INTERVAL_MS` (default 1s) the snapshot scheduler captures
both registries to durable rows. We never persist the underlying tick stream.

This keeps storage ~constant per unit time regardless of upstream feed
volatility, and lets the analyst rely on `captured_at_ms` as a single
canonical timestamp across markets and CEX sources.

## Tables

### `markets`

Polymarket Up/Down market metadata. One row per slug. The collector upserts
on every discovery tick, refreshing `last_seen_at`, `updated_at`, and the
latest raw Gamma payload (`raw_gamma` jsonb).

Key columns: `slug` (unique), `asset_symbol`, `condition_id`, `up_token_id`,
`down_token_id`, `start_ts`, `end_ts`, `resolved`, `resolved_outcome`,
`raw_gamma`.

### `book_snapshots` + `book_levels`

Periodic top-N snapshots of the reconstructed Polymarket orderbook for each
(market, outcome). One `book_snapshots` row plus `COLLECTOR_BOOK_DEPTH` × 2
`book_levels` rows per active book per scheduler tick. `book_snapshots`
references `markets.slug` via FK.

Top-of-book columns (`best_bid_e6`, `best_ask_e6`, `spread_e6`,
`tick_size_e6`, `book_hash`) are denormalized onto `book_snapshots` so
many analyses don't need to join `book_levels` at all.

### `asset_price_snapshots`

One row per scheduler tick per `(symbol)`. Holds the most-recent CEX
midpoints captured in memory at snapshot time, per-source staleness
(`*_age_ms`), and a simple-average blended midpoint (`blended_mid_e8`).
Source-count tracks how many feeds were live at the moment.

Joins to `book_snapshots` on `captured_at_ms` — the scheduler writes both
tables with the same `captured_at_ms` in one tick.

### `collector_runs` + `collector_heartbeats`

Lifecycle tracking. `collector_runs` is one row per `runCoordinator`
invocation with status, mode, and config snapshot. `collector_heartbeats` is
many rows per run, one per component per heartbeat interval
(`polymarket_ws`, `prices`).

## Scaling Conventions

- Probability prices: `*_e6` integers (`0.523` -> `523000`).
- Share sizes: `*_e6` integers.
- Asset prices (BTC/USD, ETH/USD): `*_e8` integers.
- Timestamps: `timestamptz` plus `*_ms` `bigint` columns when exact ordering
  matters. Snapshots from the same tick share an exact `captured_at_ms`.

## Migration Rules

- One migration file per schema change. Filenames sort lexicographically by
  date prefix (`YYYYMMDDHHmm_description.ts`).
- Every migration must define `up` and `down`. Down should drop everything
  `up` created.
- **Never modify a migration file after it has been applied to any database.**
  Kysely tracks applied migrations by filename in `kysely_migration`, so an
  edited file silently no-ops on existing DBs while fresh DBs get the new
  shape. This produces a state drift where two databases share the same
  migration history but have different schemas. Add a new migration file
  instead. (For dev: drop + recreate the DB if the drift is local-only.)

## Reset Boundaries

- `db:reset --yes` truncates **every** wiggler-managed table. It is the
  nuclear option for starting clean during development.
- There is no granular "reset just X" today. Add one only when an operator
  workflow actually needs it.

## Querying Conventions

- Reusable queries live under `src/lib/<domain>/queries/<topic>.ts`.
- Audit queries should return small, well-typed shapes (`Readonly<{...}>`)
  and avoid leaking Kysely types into callers.
- Use `sql` template tags only when Kysely's builder cannot express the
  query cleanly (e.g. `distinct on`).
