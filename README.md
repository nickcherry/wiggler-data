# wiggler-data

Bun + TypeScript ingestion for historical OHLCV candles across three public
CEX REST endpoints (Coinbase, Binance.US, Bitstamp).
Idempotent at the row level: re-running `candles:sync` over an
already-fetched window is a cheap no-op, and crashed runs resume from the
last open_time on disk.

## Docs

- 🧱 [Coding conventions](./doc/CODING_CONVENTIONS.md)
- ⌨️ [CLI](./doc/CLI.md)
- 🐘 [Database](./doc/DATABASE.md)
- 📊 [Candles](./doc/CANDLES.md): per-source REST shapes, pagination, rate limits.
- 🎯 [Probability grid](./doc/PROBABILITY_GRID.md): the wiggler-prob-grid-v1 config wiggler consumes.
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

## Pipeline

The full data flow is five stages. The first four are idempotent
ingestion / labeling; the fifth produces the `wiggler-prob-grid-v1`
JSON config that wiggler reads at runtime.

```
candles:sync  →  candles:vwap  →  candles:lookahead  →  candles:distributions
  (raw OHLCV       (cross-source    (forward-looking      (percentile summaries
   per source)      VWAP per          labels per           per source × lookahead;
                    minute)           candle, 1m..5m)      sanity-check tables)

                                                          ↓

                                                 candles:win-prob-grid
                                                 (calibrated probability
                                                 grid → JSON config artifact
                                                 wiggler consumes)

                                  +  candles:calibration-report   (predicted vs realized)
                                  +  candles:opportunity-report   (signal counts per day)
```

The first four stages are **research / sanity tables**: they give you
unconditional movement distributions to eyeball before you trust
anything trading. The fifth is the **deliverable**: a calibrated
`P(current_side_wins | abs_d_bps, remaining_sec, vol_bin)` grid plus
risk and fee config, dumped to `tmp/win-prob-grid/`.

See [doc/PROBABILITY_GRID.md](./doc/PROBABILITY_GRID.md) for the full
config schema and the math behind it.

## Common commands

```bash
# Health check (DB + every CEX REST endpoint reachable)
bun wiggler doctor

# 1. Backfill up to 1 year of 1m candles for BTC across every supported source
bun wiggler candles:sync

# 2. Compute cross-source volume-weighted average price for each minute
bun wiggler candles:vwap

# 3. For every candle of every source (CEX + VWAP), compute forward-looking
#    labels (max excursion, range, close-to-close return, etc.) at 1m..5m
#    horizons
bun wiggler candles:lookahead

# 4. Print percentile distribution tables of those labels — first run
#    computes and caches per-metric JSON files under `tmp/distributions/`,
#    subsequent runs are sub-second
bun wiggler candles:distributions

# 5. Emit the handoff bundle wiggler-prod consumes — per-asset config
#    + validation artifact + manifest under `tmp/bundle/`
bun wiggler candles:bundle

# Individual stages backing the bundle (run automatically by candles:bundle):
#   bun wiggler candles:win-prob-grid
#   bun wiggler candles:training-diagnostics --symbol BTC
#   bun wiggler candles:calibration-report
#   bun wiggler candles:opportunity-report

# Coverage report — rows / earliest / latest per (source, symbol, timeframe)
bun wiggler candles:status
```

### Useful variants

```bash
# Sync: only Coinbase + Binance, last 30 days
bun wiggler candles:sync --sources coinbase,binance --since 30d

# Sync: multiple symbols, custom timeframe
bun wiggler candles:sync --symbols BTC,ETH --timeframe 1h

# Sync: force a full re-pull (ignores resume cursor; useful if you suspect
# upstream revisions)
bun wiggler candles:sync --force-full-range

# Distributions: only one metric, only one source
bun wiggler candles:distributions --metrics max_abs_excursion_bps --sources coinbase

# Distributions: skip the cache (re-run the SQL)
bun wiggler candles:distributions --no-cache

# Distributions: machine-readable JSON
bun wiggler candles:distributions --json

# Win-prob grid: validation against true 5-minute market boundaries
# (rolling sample size is bigger but real markets only start at fixed
# boundaries; trust the boundary pass when the two disagree)
bun wiggler candles:win-prob-grid --anchor-step-min 5

# Win-prob grid: emit full config to stdout (e.g. for piping into wiggler)
bun wiggler candles:win-prob-grid --json
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
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `DATABASE_POOL_MAX` | (pg default) | Override pg pool max |

## Storage budget

For a full pipeline run on **1 year × 1-minute candles × 1 symbol (BTC)**:

| table | rows | on-disk (incl. indexes) |
|---|---:|---:|
| `candles` | ~2.0M (4 sources × ~525K) | ~440 MB |
| `candle_vwap` | ~525K | ~60 MB |
| `candle_lookahead_features` | ~12.7M (5 source-variants × 5 lookaheads × ~525K) | ~3.0 GB |
| **total** | **~15.3M** | **~3.5 GB** |

Adding a second symbol (e.g. ETH) roughly doubles every line. Most of the
disk goes to `candle_lookahead_features` because that table is densely
populated across both axes (5 source-variants × 5 lookahead horizons) and
keeps two btree indexes for fast training-data extraction.

If disk is tight, you can drop the lookahead table and recompute on
demand — `candles:lookahead` finishes in ~60s on a single Mac mini once
`candles` is populated, since the heavy lifting is the candle backfill,
not the labeling.

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
