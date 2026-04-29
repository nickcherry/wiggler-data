# Prices

wiggler ingests CEX price ticks from seven public WebSockets in parallel and
keeps an in-memory `CexPriceRegistry` of the most recent tick per
`(source, symbol)`. The snapshot scheduler reads that registry every
`COLLECTOR_SNAPSHOT_INTERVAL_MS` (default 1s) and writes a single
`asset_price_snapshots` row per symbol, holding both per-source midpoints
and a blended average.

**Tick-level history is not persisted.** Only the periodic snapshots are
durable. See [DATABASE.md](./DATABASE.md) for the schema.

## Why Seven Sources

Polymarket Up/Down 5-minute markets resolve against an off-chain oracle,
not against any specific CEX. Pulling from many independent free public
feeds gives us:

- **Drift detection** (one feed stale, frozen, or reconnecting — captured
  via per-source `*_age_ms` columns on each snapshot).
- **A blended midpoint** that's robust to one or two sources dropping out.
- Independent estimates of "BTC right now" without paying for an
  authenticated oracle feed.

## Sources

All seven sources are free, public, and require no authentication. Each is
reachable from a US IP at the WebSocket layer.

| Source     | Channel                              | Has reducer? | Typical tick rate (BTC) |
|------------|--------------------------------------|--------------|-------------------------|
| Coinbase   | `ticker`                             | no           | ~3–10 / s               |
| Binance    | `<symbol>@bookTicker` (binance.us)   | no           | ~3–10 / s               |
| Gemini     | v1 `marketdata` `top_of_book=true`   | no           | ~5–80 / s               |
| Bybit      | v5 spot `orderbook.1.<SYMBOL>USDT`   | no           | ~10–30 / s              |
| Bitstamp   | `order_book_<pair>`                  | no           | ~5–15 / s               |
| Bitfinex   | v2 `book` (P0, F0, len 25)           | yes          | ~10–30 / s              |
| Kraken     | v2 `book` (depth 10)                 | yes          | ~5–15 / s               |

### Coinbase Exchange — `ticker` channel

- WebSocket: `wss://ws-feed.exchange.coinbase.com`
- Subscribe: `{ type: "subscribe", product_ids: ["BTC-USD", ...], channels: ["ticker"] }`
- Inbound `priceE8` is the midpoint when both bid and ask are present;
  otherwise the trade price.

### Binance Spot — `<symbol>@bookTicker`

- WebSocket: `wss://stream.binance.us:9443/stream?streams=btcusdt@bookTicker`
- We default to `binance.us` because `binance.com` is geo-blocked from the US.
  Override `BINANCE_WS_URL` if running outside the US.
- Inbound `priceE8` is always the midpoint of best bid/ask.

### Gemini — v1 marketdata top-of-book

- WebSocket: `wss://api.gemini.com/v1/marketdata/<PAIR>?top_of_book=true&bids=true&offers=true&trades=false`
- One socket per symbol (the URL carries the symbol), so the client
  multiplexes one inner connection per subscribed symbol.
- The first event after connect uses `reason: "initial"` for both sides;
  subsequent events use `reason: "top-of-book"` for one side at a time.
- `priceE8` is the midpoint of the best bid and best ask. A side is
  invalidated when its `remaining` drops to 0 between top-of-book frames.

### Bybit Spot — v5 `orderbook.1`

- WebSocket: `wss://stream.bybit.com/v5/public/spot`
- Subscribe: `{ op: "subscribe", args: ["orderbook.1.BTCUSDT", ...] }`
- Depth-1 frames carry the current best bid/ask directly. Bybit may send
  delta frames where one side's array is empty; the client retains the
  prior side until a new value arrives.
- Note: Bybit prohibits US persons by ToS. The public market data
  endpoint is reachable from US IPs (no IP block at the network layer),
  but operators should consider this acceptable for their use case before
  running in production.

### Bitstamp — `order_book_<pair>`

- WebSocket: `wss://ws.bitstamp.net`
- Subscribe: `{ event: "bts:subscribe", data: { channel: "order_book_btcusd" } }`
- Each event already contains the top-100 bids and asks (sorted best-first),
  so the client takes `bids[0]` and `asks[0]` directly.
- Event timestamps come in as `microtimestamp` (µs) and `timestamp` (s);
  the client prefers the higher-precision `microtimestamp`.

### Bitfinex — v2 `book` (P0, F0, len 25)

- WebSocket: `wss://api-pub.bitfinex.com/ws/2`
- Subscribe: `{ event: "subscribe", channel: "book", symbol: "tBTCUSD",
  prec: "P0", freq: "F0", len: "25" }`
- Bitfinex's `ticker` channel is trade-driven and far too sparse for 1s
  cadence (~0.1 ticks/s on BTCUSD). The `book` channel fires on every
  level change.
- Frames are arrays: `[chanId, [price, count, amount]]` for updates or
  `[chanId, [[price, count, amount], ...]]` for the initial snapshot.
  `count == 0` deletes the level; the sign of `amount` (`+` for bid,
  `-` for ask) selects which side. The client maintains a
  `TopOfBookTracker` per channel.

### Kraken — v2 `book` (depth 10)

- WebSocket: `wss://ws.kraken.com/v2`
- Subscribe: `{ method: "subscribe", params: { channel: "book",
  symbol: ["BTC/USD"], depth: 10 } }`
- Kraken v2 accepts canonical `BTC/USD` (v1 used `XBT/USD`). The simple
  `ticker` channel is trade-driven (~0.2 ticks/s); the `book` channel
  fires on every level change.
- Frames: `{ channel: "book", type: "snapshot" | "update",
  data: [{ symbol, bids: [{price, qty}], asks: [{price, qty}], ... }] }`.
  `qty == 0` deletes the level. The client maintains a `TopOfBookTracker`
  per symbol.

## Symbol Mapping

The application uses canonical bare symbols (`BTC`, `ETH`, `SOL`). Each
client maps symbols to its exchange's pair convention:

- Coinbase: `BTC` -> `BTC-USD`
- Binance: `BTC` -> `BTCUSDT`
- Gemini: `BTC` -> `BTCUSD`
- Bybit: `BTC` -> `BTCUSDT`
- Bitstamp: `BTC` -> `btcusd`
- Bitfinex: `BTC` -> `tBTCUSD`
- Kraken: `BTC` -> `BTC/USD`

`from*Symbol` helpers in [symbols.ts](../src/lib/prices/symbols.ts) do the
reverse mapping when building `PriceTick` rows from inbound frames.

`PRICE_SYMBOLS` (env, default `BTC`) is the comma-separated list of
canonical symbols subscribed to on `collect:start`.

## Price Coordinator

`startPriceCoordinator` ([coordinator.ts](../src/lib/prices/coordinator.ts))
connects all seven WS clients, owns their reconnect lifecycles, and writes
a single `prices` heartbeat every 5s with per-source `<src>Status` and
`<src>LastTickAtMs` fields. Its **only output** is the `CexPriceRegistry`
it returns synchronously to the caller — every inbound tick `record()`s
into that registry, replacing any prior state for the same `(source,
symbol)`.

The price coordinator never writes tick data to the database. Persistence
is the snapshot scheduler's job.

## Top-of-Book Tracker

`TopOfBookTracker` ([topOfBookTracker.ts](../src/lib/prices/topOfBookTracker.ts))
is a tiny helper used by the Bitfinex and Kraken clients (the two whose
WS feeds emit incremental L2 updates rather than top-of-book frames).
It tracks bid and ask price-level sets and computes
`max(bids) / min(asks)` per call. Sizes are not retained — only the prices
matter for midpoint computation. The client constructs a fresh tracker
for each new WS session, since a prior session's book state no longer
reflects the exchange.

## Blended Midpoint

`blendPrices` is a simple-average of whatever sources have a non-null
midpoint at snapshot time. Sources with `null` midpoints are skipped;
`source_count` records how many actually contributed (out of 7), so
analysis can filter snapshots where only a subset of feeds were live.

## Auditing

- `audit:latest --asset BTC` includes a `CEX prices` section with the
  blended midpoint, source count, and a per-source line for each of the
  seven sources showing midpoint and staleness.
- `audit:prices --asset BTC --since 1h` summarizes total snapshots,
  range, and the most recent snapshot's per-source values + staleness.
- `tail:prices --asset BTC` streams new `asset_price_snapshots` rows
  live with all seven per-source midpoints.

Freshness threshold in `audit:latest`:

- `WARN` if the most recent `asset_price_snapshots` row is older than 3
  seconds (3× the default 1s scheduler cadence).

## Known Edge Cases

- Binance.us has thinner liquidity than binance.com, so the inbound tick
  rate is ~2× lower than Coinbase's. Snapshot quality is unaffected
  because we only need ≥1 inbound tick per scheduler tick to write a
  fresh row.
- Coinbase emits `subscriptions`, `heartbeat`, and `error` frames in addition
  to `ticker`. Non-`ticker` frames are dropped silently by the schema parser.
- Binance occasionally serves a non-combined frame even on combined-stream
  URLs (rare). The schema accepts both shapes (`{stream, data}` and bare
  bookTicker).
- Bitstamp's `order_book_<pair>` channel sends a full top-100 snapshot
  every frame, so its tick rate is lower than the bookTicker-style
  feeds (~5–15/s) but per-frame overhead is higher.
- Bybit's public WS is not IP-blocked from the US, but Bybit's ToS
  prohibits US persons from using the platform. Operators should consider
  whether public-data-only consumption is acceptable for their use case.
- Bitfinex's `ticker` channel is trade-driven and unsuitable for 1s
  cadence — the `book` channel must be used instead. Same for Kraken's
  `ticker`.
