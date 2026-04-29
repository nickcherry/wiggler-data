# CLI

The CLI is the operator-facing contract for wiggler.

Almost everything that matters should be reachable through one non-interactive entrypoint:

`bun wiggler`

For execution expectations, see [EXECUTION.md](./EXECUTION.md). For the schema the commands read and write, see [DATABASE.md](./DATABASE.md). For Polymarket-specific data flow, see [POLYMARKET.md](./POLYMARKET.md). For CEX price ingestion, see [PRICES.md](./PRICES.md).

## Core Rules

- Use one entrypoint: `bun wiggler`.
- Operator workflows belong under `bun wiggler <command>`, not ad hoc package scripts.
- `package.json` scripts are for repo maintenance only: `check`, `typecheck`, `lint`, `test`, `format`.
- Commands must stay non-interactive by default.
- Help output must be enough for a human or agent to understand side effects before running the command.
- Parsing and validation belong in the command definition (Zod schemas), not in downstream business logic.
- Shared CLI mechanics live in `src/lib/cli/`.
- Domain logic lives outside command files; command files should stay thin.

## Active Command Families

- `doctor` — runtime health check (env, DB, Gamma reachability).
- `db:*`
  - `db:migrate`
  - `db:status`
  - `db:rollback`
  - `db:reset --yes` (truncates all wiggler tables; destructive)
- `market:*`
  - `market:current --asset BTC`
  - `market:by-slug <slug>`
  - `market:discover --asset BTC --lookahead 3 --lookback 3` (writes to DB)
  - `market:windows --asset BTC --around now`
  - `market:resolve <slug>`
- `collect:*`
  - `collect:start --asset BTC` — Polymarket + CEX price feeds together. Default for live operation.
  - `collect:polymarket --asset BTC` — Polymarket book snapshots only; CEX price snapshots are skipped.
- `audit:*`
  - `audit:latest --asset BTC`
  - `audit:market <slug>`
  - `audit:gaps --asset BTC --since 24h`
  - `audit:book <slug>` (compact time series; `--at <ISO>` for top-N at a moment)
  - `audit:prices --asset BTC --since 1h`
- `analyze:*`
  - `analyze:window <slug>` — per-second timeline of pct_move + Up/Down top-of-book for one market.
- `backtest:*`
  - `backtest:trigger --side --min-pct-move --max-seconds-left --max-entry-price --min-fill-size` — aggregate hit rate + mean PnL for one trigger configuration across every resolved market.
- `export:*`
  - `export:snapshots --market <slug> --out tmp/snapshots.ndjson`
- `tail:*`
  - `tail:books --asset BTC`
  - `tail:prices --asset BTC`

## Command Shape

- Prefer `namespace:action`.
- Keep names literal and unsurprising.
- Use explicit options instead of implicit behavior.
- Describe output and side effects in the command metadata.
- Most commands accept `--json` for machine-readable output.
- `--asset SYMBOL` defaults to `env.defaultAsset` (`BTC` unless overridden).

## Help And Discoverability

- `bun wiggler` prints top-level help.
- `bun wiggler help <command>` prints command help.
- `bun wiggler <command> --help` does the same without executing.

Every command should explain:

- inputs
- output
- side effects
- examples

The intent is that an operator or agent can start at `bun wiggler`, inspect one command, and make a correct call without reading a large amount of implementation code first.

## Output Rules

- Prefer stable, terse, high-signal stdout.
- Long-running collectors emit structured JSON log lines (one per line).
- Print real counts, ages, slugs, and prices where those are operationally relevant.
- All timestamps in CLI output are UTC ISO 8601.
- `audit:latest` and `audit:gaps` exit non-zero on `FAIL`; `WARN` is exit 0 with a status indicator.

## Destructive Commands

- `db:reset --yes` truncates every wiggler-managed table. Always require `--yes`.
- `db:rollback` runs one `down` migration; only meaningful when iterating on schema during development.

## File Layout

- `src/bin/index.ts` — top-level command registry.
- `src/bin/<namespace>/...` — command definition files.
- `src/lib/cli/...` — shared parsing, help, completion, and error boundaries.

Keep command code in `src/bin/<namespace>/...`; do not add alternate command trees.
