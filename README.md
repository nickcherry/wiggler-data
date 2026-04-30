# wiggler-data

Bun + TypeScript ingestion for historical OHLCV candles across four public
CEX REST endpoints (Coinbase, Binance.US, Bitstamp, Bitfinex).
Idempotent at the row level: re-running `candles:sync` over an
already-fetched window is a cheap no-op, and crashed runs resume from the
last open_time on disk.

## Docs

- 🧱 [Coding conventions](./doc/CODING_CONVENTIONS.md)
- ⌨️ [CLI](./doc/CLI.md)
- 🐘 [Database](./doc/DATABASE.md)
- 📊 [Candles](./doc/CANDLES.md): per-source REST shapes, pagination, rate limits.
- 📚 [Documentation conventions](./doc/DOCUMENTATION.md)
- ✅ [Execution](./doc/EXECUTION.md)
- 🧰 [Stack](./doc/STACK.md)
- 🤝 [How to work with Nick](./doc/HOW_TO_WORK_WITH_NICK.md)

## Setup

```bash
bun install
cp .env.example .env
createdb wiggler
bun wiggler db:migrate
bun wiggler doctor
```

Every supported CEX REST endpoint is public — no API keys required.

## Common commands

```bash
# Health check (DB + every CEX REST endpoint reachable)
bun wiggler doctor

# Backfill up to 1 year of 1m candles for BTC across every supported source
bun wiggler candles:sync

# Only Coinbase + Binance, last 30 days
bun wiggler candles:sync --sources coinbase,binance --since 30d

# Multiple symbols, custom timeframe
bun wiggler candles:sync --symbols BTC,ETH --timeframe 1h

# Force a full re-pull (ignores resume cursor; useful if you suspect
# upstream revisions)
bun wiggler candles:sync --force-full-range

# Coverage report
bun wiggler candles:status
```

## Environment variables

| name | default | purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://localhost:5432/wiggler` | PostgreSQL connection |
| `DEFAULT_ASSET` | `BTC` | Default asset symbol |
| `DEFAULT_SYMBOLS` | `BTC` | Comma-separated symbols when `--symbols` is omitted |
| `COINBASE_REST_BASE_URL` | `https://api.exchange.coinbase.com` | Coinbase Exchange |
| `BINANCE_REST_BASE_URL` | `https://api.binance.us` | Binance.US (binance.com is geo-blocked from the US) |
| `BITSTAMP_REST_BASE_URL` | `https://www.bitstamp.net` | Bitstamp |
| `BITFINEX_REST_BASE_URL` | `https://api-pub.bitfinex.com` | Bitfinex |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `DATABASE_POOL_MAX` | (pg default) | Override pg pool max |

## Storage budget

1 year × 1-minute candles × 4 sources × 1 symbol ≈ 2.1M rows. Each row is
~150 bytes including indexes, so a full BTC backfill is **~320 MB total**.
Adding a second symbol roughly doubles it.

## What this app intentionally does NOT do

- No real-time WebSocket streaming. Historical candles only.
- No order execution, wallet auth, or PnL modeling.
- No Polymarket / prediction-market integration.

## Known limitations

- **Kraken, Gemini, and Bybit are not included.** Kraken/Gemini's public
  OHLC endpoints only return the most recent ~12 hours / ~1 day of 1m
  data, which is useless for a 1-year backfill. Bybit's CDN blocks US
  IPs (HTTP 403) and there is no US fallback host. Add support if the
  use case justifies it.
- **No automatic deduplication across sources.** Each `(source, symbol,
  timeframe, open_time)` is its own row. Differences across sources are
  expected (separate liquidity pools, separate last-trade feeds) and the
  consumer blends them as needed.
