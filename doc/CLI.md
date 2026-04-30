# CLI

The CLI is the operator-facing contract for wiggler.

`bun wiggler` is the single entrypoint. For schema details see
[DATABASE.md](./DATABASE.md); for per-source REST quirks see
[CANDLES.md](./CANDLES.md).

## Core Rules

- One entrypoint: `bun wiggler`.
- Operator workflows belong under `bun wiggler <command>`, not ad hoc
  package scripts.
- `package.json` scripts are for repo maintenance only: `check`,
  `typecheck`, `lint`, `test`, `format`.
- Commands must stay non-interactive by default.
- Help output must be enough for a human or agent to understand side
  effects before running the command.
- Parsing and validation belong in the command definition (Zod schemas),
  not in downstream business logic.
- Shared CLI mechanics live in `src/lib/cli/`.
- Domain logic lives outside command files; command files should stay thin.

## Active Command Families

- `doctor` — runtime health check (env, DB, every CEX REST endpoint reachable)
- `db:*`
  - `db:migrate`
  - `db:status`
  - `db:rollback`
  - `db:reset --yes` — truncates all wiggler tables; destructive
- `candles:*`
  - `candles:sync` — backfills OHLCV candles for the requested
    `(source, symbol, timeframe)` combinations. Idempotent. Resumes from
    the last open_time on disk unless `--force-full-range`.
  - `candles:status` — coverage report per `(source, symbol, timeframe)`.
  - `candles:vwap` — cross-source VWAP rows from `candles`.
  - `candles:lookahead` — forward-looking label rows for every
    `(source, symbol, timeframe)` and lookahead horizon.
  - `candles:distributions` — percentile-distribution tables per
    `(source, lookahead)` of every lookahead metric.
  - `candles:win-prob-grid` — calibrated `wiggler-prob-grid-v1` JSON
    config (the deliverable wiggler reads at runtime). See
    [PROBABILITY_GRID.md](./PROBABILITY_GRID.md).
  - `candles:calibration-report` — predicted-vs-realized win rate by
    `p_win_lower` decile against the cached config.
  - `candles:opportunity-report` — count of decision states crossing
    each confidence threshold; per-day rate.

## Command Shape

- Prefer `namespace:action`.
- Keep names literal and unsurprising.
- Use explicit options instead of implicit behavior.
- Describe output and side effects in the command metadata.
- Most commands accept `--json` for machine-readable output.

## Help And Discoverability

- `bun wiggler` prints top-level help.
- `bun wiggler help <command>` prints command help.
- `bun wiggler <command> --help` does the same without executing.

## Output Rules

- Prefer stable, terse, high-signal stdout.
- Long-running commands emit structured JSON log lines (one per line).
- Print real counts, ages, and timestamps where operationally relevant.
- All timestamps in CLI output are UTC ISO 8601.
- Commands exit non-zero on `FAIL`/error.

## Destructive Commands

- `db:reset --yes` truncates every wiggler-managed table. Always require
  `--yes`.
- `db:rollback` runs one `down` migration; only meaningful when iterating
  on schema during development.

## File Layout

- `src/bin/index.ts` — top-level command registry.
- `src/bin/<namespace>/...` — command definition files.
- `src/lib/cli/...` — shared parsing, help, completion, and error boundaries.

Keep command code in `src/bin/<namespace>/...`; do not add alternate
command trees.
