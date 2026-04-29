# Wiggler

Bun + TypeScript collector for Polymarket's recurring Up/Down 5-minute
markets, plus parallel Coinbase + Binance asset-price ingestion. Storage is
**snapshot-only**: WS frames are reduced to in-memory state, and the
scheduler captures both the Polymarket book and the latest CEX prices to
durable rows once per second on a single uniform cadence.

> **This app does not trade. It only collects and audits data.**

## Docs

- 🧱 [Coding conventions](./doc/CODING_CONVENTIONS.md): structure, typing, testing, CLI, complexity rules.
- ⌨️ [CLI](./doc/CLI.md): the single-entrypoint `bun wiggler` contract and active commands.
- 🐘 [Database](./doc/DATABASE.md): persisted tables, snapshot model, migration rules.
- 🟢 [Polymarket](./doc/POLYMARKET.md): Up/Down 5m market discovery, WS, book reconstruction.
- 💱 [Prices](./doc/PRICES.md): CEX asset price snapshots.
- 📈 [Analysis](./doc/ANALYSIS.md): per-window timelines and the `backtest:trigger` configuration sweep.
- 🤝 [How to work with Nick](./doc/HOW_TO_WORK_WITH_NICK.md): collaboration expectations.

## What it does

- Discovers current/next/recent Up/Down 5m markets via Polymarket Gamma.
- Subscribes to the Polymarket market WebSocket and reconstructs each
  outcome's orderbook in memory.
- Subscribes to seven public CEX WebSockets in parallel (Coinbase, Binance,
  Gemini, Bybit, Bitstamp, Bitfinex, Kraken) and keeps the latest
  mid/bid/ask per `(source, symbol)` in memory.
- Once per `COLLECTOR_SNAPSHOT_INTERVAL_MS` (default 1s) writes one
  `book_snapshots` + `book_levels` row per active (market, outcome) and one
  `asset_price_snapshots` row per symbol. Both share the same
  `captured_at_ms` for clean joins.
- Audits the resulting data: snapshot freshness, complement-price sanity,
  market-window coverage, per-source CEX freshness.

## What it does NOT do

- **No tick-level history.** Polymarket WS frames and CEX ticks are not
  persisted; only the per-tick snapshots are.
- **No trade prints.** Trades are reflected in the next book frame's
  `last_trade_price` field but the discrete prints are not stored.
- No trading, wallet auth, or order placement.
- No strategy logic, ML, or backtesting.
- No dashboard UI or notifications.

## Setup

```bash
bun install
cp .env.example .env
createdb wiggler
bun wiggler db:migrate
bun wiggler doctor
```

All seven CEX WebSockets are public and require no API keys. Bybit's
public market data is reachable from US IPs even though Bybit's ToS
restricts US users from the platform itself; if that's not acceptable,
disable it by overriding `BYBIT_WS_URL` to an unreachable endpoint or
removing it from the coordinator wiring.

## Common commands

```bash
# Health
bun wiggler doctor
bun wiggler db:status

# Discover markets
bun wiggler market:current --asset BTC
bun wiggler market:windows --asset BTC --around now
bun wiggler market:by-slug btc-updown-5m-1777475700
bun wiggler market:discover --asset BTC --lookahead 3 --lookback 3

# Run the collector (Ctrl+C to stop)
bun wiggler collect:start --asset BTC

# Polymarket only (no CEX price snapshots)
bun wiggler collect:polymarket --asset BTC

# Audits
bun wiggler audit:latest --asset BTC
bun wiggler audit:market btc-updown-5m-1777475700
bun wiggler audit:gaps --asset BTC --since 24h
bun wiggler audit:book btc-updown-5m-1777475700
bun wiggler audit:book btc-updown-5m-1777475700 --at 2026-04-29T15:17:30Z --depth 10
bun wiggler audit:prices --asset BTC --since 1h

# Analysis
bun wiggler analyze:window btc-updown-5m-1777475700
bun wiggler backtest:trigger --side Up --min-pct-move 0.005 --max-seconds-left 60 --max-entry-price 0.85 --min-fill-size 100

# Exports
bun wiggler export:snapshots --market btc-updown-5m-1777475700 --out tmp/snapshots.ndjson

# Tails
bun wiggler tail:books  --asset BTC
bun wiggler tail:prices --asset BTC
```

## Environment variables

| name                              | required | default                                                | purpose                                  |
| --------------------------------- | -------- | ------------------------------------------------------ | ---------------------------------------- |
| `DATABASE_URL`                    | yes      | `postgres://localhost:5432/wiggler`                    | PostgreSQL connection                    |
| `POLYMARKET_GAMMA_BASE_URL`       | no       | `https://gamma-api.polymarket.com`                     | Gamma REST                               |
| `POLYMARKET_CLOB_BASE_URL`        | no       | `https://clob.polymarket.com`                          | CLOB REST (for future use)               |
| `POLYMARKET_WS_URL`               | no       | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | Polymarket market WS                     |
| `DEFAULT_ASSET`                   | no       | `BTC`                                                  | Default asset symbol                     |
| `PRICE_SYMBOLS`                   | no       | `BTC`                                                  | Comma-separated symbols snapshotted from CEX feeds |
| `COINBASE_WS_URL`                 | no       | `wss://ws-feed.exchange.coinbase.com`                  | Coinbase Exchange WS                     |
| `BINANCE_WS_URL`                  | no       | `wss://stream.binance.us:9443`                         | Binance Spot WS (binance.com is geo-blocked from the US) |
| `GEMINI_WS_BASE_URL`              | no       | `wss://api.gemini.com/v1/marketdata`                   | Gemini v1 marketdata base (per-symbol path appended) |
| `BYBIT_WS_URL`                    | no       | `wss://stream.bybit.com/v5/public/spot`                | Bybit v5 public spot WS                  |
| `BITSTAMP_WS_URL`                 | no       | `wss://ws.bitstamp.net`                                | Bitstamp public WS                       |
| `BITFINEX_WS_URL`                 | no       | `wss://api-pub.bitfinex.com/ws/2`                      | Bitfinex v2 public WS                    |
| `KRAKEN_WS_URL`                   | no       | `wss://ws.kraken.com/v2`                               | Kraken v2 WS                             |
| `COLLECTOR_SNAPSHOT_INTERVAL_MS`  | no       | `1000`                                                 | Uniform cadence for book + price snapshots |
| `COLLECTOR_BOOK_DEPTH`            | no       | `20`                                                   | Top-N book levels persisted per snapshot |
| `LOG_LEVEL`                       | no       | `info`                                                 | `debug`, `info`, `warn`, `error`         |
| `DATABASE_POOL_MAX`               | no       | (pg default)                                           | Override pg pool max                     |

## How to audit health

After running `collect:start` for a few minutes:

- `audit:latest` should report `Status: OK` (or `WARN` with a clear reason).
- `audit:market <slug>` should show snapshot counts close to expected
  (`floor(window_seconds) × 2` outcomes at 1s cadence).
- `audit:gaps --since 1h` should show no missing markets.
- `audit:prices --since 1h` should show fresh per-source midpoints with
  staleness < ~3s and a sane price range.

## Storage budget

At the default 1s cadence with depth 20 and 1 asset (BTC), expect:

- ~3.4 GB / day → ~50 GB / 14 days
- `book_levels` is ~70% of that (~36 levels × ~92 B per snapshot)
- `asset_price_snapshots` is < 1% of total

Lower the cadence (`COLLECTOR_SNAPSHOT_INTERVAL_MS=5000`) for ~5× less data.

## Known limitations

- Polymarket only currently runs Up/Down markets for BTC. Slug helpers and
  market discovery are asset-agnostic, so adding ETH/SOL is a config change
  once Polymarket lists them.
- No backfilled rebuilds: if the collector restarts mid-window, snapshots
  resume after the next `book` frame is received from Polymarket.
