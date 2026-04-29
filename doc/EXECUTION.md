# Execution

## Required Validation

- Every completed change must pass `bun run typecheck`.
- Every completed change must pass `bun run lint`.
- Prefer `bun run lint:fix` first.
  If it succeeds and leaves the worktree clean from lint-driven changes, that is sufficient and you do not need to run `bun run lint` again.
  It removes trivial churn such as formatting drift and import-order fixes before review.
- When tests exist for the changed behavior or should exist for the changed behavior, run them.
- For net-new work, come back with the change already typechecked, linted, and tested when tests are practical.
- `bun run check` runs typecheck + lint + tests in one command and is the default expectation before declaring something done.
- If a change touches runtime behavior, validate it with the narrowest safe local check that proves the behavior without unnecessary side effects.
- If a validation step cannot be run, say so explicitly and explain why.
- Do not spend disproportionate time waiting on exhaustive validation when a smaller check is enough to establish confidence. Use judgment.

## Documentation As Part Of Completion

- If a change adds or reshapes a large piece of functionality, architecture, or workflow, check `doc/` before finishing.
- Update the existing doc if one already covers the area.
- Create a focused new doc when the context is too large or cross-cutting to live comfortably in code comments.
- Follow the documentation rules in [DOCUMENTATION.md](./DOCUMENTATION.md).

## CLI Validation

- Validate CLI changes through the actual entrypoint: `bun wiggler ...`.
- For command discovery or top-level UX changes, run `bun wiggler` and `bun wiggler --help`.
- For command-specific changes, run the affected command directly and verify its output or error handling.
- Prefer targeted command checks over broad manual clicking around or speculative reasoning.
- Prefer dry-runs (`market:discover --dry-run`), `--json` output, or fixture/temp data before touching durable data or live external services.
- If the useful validation path is potentially destructive (`db:reset --yes`, large `market:discover` runs), state the risk and ask before running it when intent is not clear.

## Live System Validation

- The collector talks to public Polymarket, Coinbase, and Binance WebSockets. None of these write back, but they do count as real-system traffic.
- Before running `collect:start` for an extended period, confirm the schema is migrated and there is database disk to spare. Binance bookTicker can fire >100 events/sec per symbol.
- Use `bun wiggler doctor` first to confirm Postgres connectivity, schema presence, and Gamma reachability.

## Debugging And Investigation

- Reproduce the issue or confirm the failure mode before making broad fixes.
- For bug fixes, verify the bug exists first, make the change, then verify the bug is actually gone.
- Validate assumptions with code, logs, command output, or documentation instead of guessing.
- Narrow the problem first. Identify whether the issue is parsing, command dispatch, validation, formatting, WS reconnection, or DB write before changing multiple layers.
- Raw events in `polymarket_ws_events` and raw JSON in `price_ticks.raw` are the source of truth for parser bugs. Re-derive normalized rows from them when in doubt.

## Execution Discipline

- Match the thoroughness of validation to the downside risk and the size of the change.
- Act first when the downside is low. Ask first when the action is destructive, ambiguous, or likely to create cleanup pain.
- Prefer evidence over assumptions.
- Keep temporary debugging code, console output, and scratch artifacts out of the final change.
- Leave the codebase easier to understand than you found it.
