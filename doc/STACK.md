# Stack

## Core Stack

- Bun for runtime, package management, and the CLI entrypoint.
- TypeScript with strict static validation through `tsc`.
- Zod for boundary validation and schema-first typing.
- PostgreSQL for persistence.
- Kysely for type-safe SQL and schema migrations.
- `pg` as the PostgreSQL driver used by Kysely.
- `ws` as the WebSocket client for Polymarket, Coinbase, and Binance.
- Environment access centralized through `src/constants/env.ts`.

## External Services

- Polymarket Gamma REST (`https://gamma-api.polymarket.com`) — market metadata.
- Polymarket CLOB market WebSocket (`wss://ws-subscriptions-clob.polymarket.com/ws/market`) — orderbook + trade stream.
- Coinbase Exchange WebSocket (`wss://ws-feed.exchange.coinbase.com`) — `ticker` channel for `<SYMBOL>-USD` pairs.
- Binance Spot combined-stream WebSocket (`wss://stream.binance.com:9443/stream?streams=...`) — `bookTicker` per symbol.

All four are public and require no authentication for the data we consume.

## Tooling

- ESLint for code quality and import hygiene (with `simple-import-sort` and `unused-imports`).
- Prettier for formatting (`trailingComma: "all"`).
- `bun test` for unit tests.

## Current Shape

- wiggler is a CLI-first application.
- The entrypoint lives at `src/bin/index.ts`.
- CLI behavior and command structure are documented in [CLI.md](./CLI.md).
- Domain constants live under `src/constants/`.
- Reusable application logic lives under `src/lib/`.
- Database access and migrations live under `src/lib/db/`.
- Polymarket-specific code lives under `src/lib/polymarket/`.
- CEX price-feed code lives under `src/lib/prices/`.
- The collector coordinator that runs everything together lives in `src/lib/collector/`.
- Internal engineering and architecture docs live under `doc/`.

## Philosophy

- Keep the stack small and boring unless a new dependency clearly earns its place.
- Prefer tools that reinforce type safety, validation, and reviewability.
- Choose conventions that make the system easier to reason about across sessions, not just faster to sketch once.
- One mode by default. No `*_ENABLED` toggles for things that should always run.
