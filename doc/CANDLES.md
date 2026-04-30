# Candles

Wiggler ingests OHLCV candles from four public CEX REST endpoints and
stores one row per `(source, symbol, timeframe, open_time)` in the
`candles` table.

## Why these four sources

Of the seven major CEX feeds we considered, only these four expose **deep
historical 1-minute history** through their public REST endpoints AND are
reachable from a US IP:

| source     | endpoint                                          | per-request limit | 1y of 1m candles |
|------------|---------------------------------------------------|-------------------|------------------|
| coinbase   | `GET /products/{pair}/candles?granularity=60`     | 300               | ~5h per call     |
| binance    | `GET /api/v3/klines?interval=1m`                  | 1000              | ~16h per call    |
| bitstamp   | `GET /api/v2/ohlc/{pair}/?step=60`                | 1000              | ~16h per call    |
| bitfinex   | `GET /v2/candles/trade:1m:{pair}/hist`            | 10000             | ~7d per call     |

Excluded:

- **Kraken** and **Gemini** — public OHLC endpoints only return the most
  recent ~12h / ~1d of 1m data. Useless for a year-long backfill.
- **Bybit** — `api.bybit.com` is fronted by CloudFront and returns HTTP
  403 ("configured to block access from your country") on US IPs. Bybit
  operates no US entity / fallback host. Add support if running outside
  the US becomes a goal.

## Per-source quirks

Every source's REST shape is slightly different. The notable gotchas:

- **Coinbase** returns `[time, low, high, open, close, volume]` (note the
  `low`/`high`/`open`/`close` order — different from everyone else) in
  **descending** order. We re-sort to ascending.
- **Bitfinex** returns `[mts, open, close, high, low, volume]` — `close`
  before `high` before `low`. Easy to swap by mistake.
- **Bitstamp** returns rows as named-key objects, not arrays. Timestamps
  are unix **seconds** as strings.
- **Binance** uses **USDT** quotes (`BTCUSDT`); the others use plain USD.
- **Bitstamp** anchors the response window on `end` + `limit`, not
  `start`. Asking for `(start=A, end=B, limit=1000)` on a 30-min window
  returns 1000 candles ending at `B`, including data BEFORE `A`. The
  fetcher works around this by clamping `limit` to the candles that fit
  in the window and filtering the response defensively.

The per-source files in `src/lib/candles/sources/` document these
explicitly and normalize everything to one canonical `Candle` shape:
prices and volumes as integer 1e8 units (`*_e8`), `open_time_ms` as bigint
ms, and `tradeCount` only when the source reports it.

## Schema

```
candles (
  source, symbol, exchange_pair, timeframe,
  open_time, open_time_ms,
  open_e8, high_e8, low_e8, close_e8, volume_e8,
  trades, fetched_at
)
PRIMARY KEY (source, symbol, timeframe, open_time)
```

The composite PK does the upsert work for us. Re-running `candles:sync`
over an already-fetched window updates each row's OHLCV in place
(and refreshes `fetched_at`) instead of producing duplicates.

`candle_sync_runs` records one row per sync invocation per series with
`status: running | completed | failed`, `rows_upserted`, and any error
message. Useful audit trail; never on the hot path.

## Resume semantics

`syncCandleSeries` looks up `MAX(open_time_ms)` for the
`(source, symbol, timeframe)` and starts the next fetch one full
timeframe-interval after that. So:

- First run with `--since 1y`: fetches the full year.
- Second run minutes later: fetches only the minute(s) since the first
  run finished.
- Crashed mid-run: re-running picks up from the last successfully
  upserted batch.
- `--force-full-range`: bypasses the resume cursor and re-fetches every
  candle in the range. Useful when you suspect upstream revisions.

## Rate limits

Each source has its own published rate limit. We pace requests well below
the published ceiling per source:

| source   | published | wiggler pace      |
|----------|-----------|-------------------|
| coinbase | ~10/s     | ~5/s (200ms gap)  |
| binance  | 1200 weight/min, klines costs 2 | ~5/s (200ms gap) |
| bitstamp | 8000 / 10min | ~5/s (200ms gap) |
| bitfinex | ~90/min   | ~0.7/s (1500ms gap) |

Each fetcher handles `429` and 5xx responses with exponential backoff
(starting at 250ms, capped at 10s, max 5 attempts). Backoff events log at
`warn` level so transient throttling is observable.

## Output

Wall-clock for a full 1-year × 1m × 4-source × 1-symbol backfill is
roughly:

- coinbase: ~525,600 candles / 300 per req × 200ms ≈ **6 min**
- binance: ~525,600 / 1000 × 200ms ≈ **2 min**
- bitstamp: ~525,600 / 1000 × 200ms ≈ **2 min**
- bitfinex: ~525,600 / 10000 × 1500ms ≈ **1.5 min**

Sources run in parallel (each has its own rate limit), so the wall-clock
is dominated by the slowest one (~6 min).
