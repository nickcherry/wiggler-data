# Stack

## Core Stack

- **Bun** for runtime, package management, and the CLI entrypoint.
- **TypeScript** with strict static validation through `tsc`.
- **Zod** for boundary validation and schema-first typing (CLI input,
  external REST responses).
- **PostgreSQL** for persistence.
- **Kysely** for type-safe SQL and schema migrations.
- **`pg`** as the PostgreSQL driver under Kysely.
- Environment access centralized through `src/constants/env.ts`.
- Built-in `fetch` for REST calls — no third-party HTTP client.

## External Services

- **Coinbase Exchange REST** (`https://api.exchange.coinbase.com`)
- **Binance.US REST** (`https://api.binance.us`) — Binance.com is
  geo-blocked from the US.
- **Bitstamp REST** (`https://www.bitstamp.net`)

All three are public and require no authentication. See
[CANDLES.md](./CANDLES.md) for per-source REST shapes and rate limits.

## Tooling

- **ESLint** for code quality and import hygiene
  (`simple-import-sort`, `unused-imports`).
- **Prettier** for formatting (`trailingComma: "all"`).
- **`bun test`** for unit tests.

## Current Shape

- wiggler is a CLI-first application.
- Entrypoint: `src/bin/index.ts`.
- CLI behavior and command structure: [CLI.md](./CLI.md).
- Domain constants: `src/constants/`.
- Reusable application logic: `src/lib/`.
- Database access and migrations: `src/lib/db/`.
- Per-source candle fetchers: `src/lib/candles/sources/`.
- Internal docs: `doc/`.

## Philosophy

- Keep the stack small and boring unless a new dependency clearly earns
  its place.
- Prefer tools that reinforce type safety, validation, and reviewability.
- Choose conventions that make the system easier to reason about across
  sessions, not just faster to sketch once.
- One mode by default. No `*_ENABLED` toggles.
