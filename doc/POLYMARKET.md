# Polymarket

wiggler ingests two streams from Polymarket:

1. **Gamma REST** for market metadata.
2. **CLOB market WebSocket** for orderbook deltas.

For the underlying asset price (the BTC/ETH/SOL/USD figure each market is
judged against), see [PRICES.md](./PRICES.md). Polymarket itself does not
publish that price.

## Up/Down 5-Minute Markets

Each window is a separate Polymarket event with the slug shape:

```
<asset>-updown-5m-<unix_start_seconds>
```

For example: `btc-updown-5m-1777475700` is the BTC market starting at unix
`1777475700` and resolving 5 minutes later. The slug suffix is the canonical
window-start time; do not infer the start from `event.startDate` in the
Gamma response — that's the event creation timestamp, not the market-window
start.

`buildUpDownSlugFromWindow(asset, window)` produces these slugs from a
5-minute aligned `MarketWindow`. The asset is encoded in the slug, so adding
ETH/SOL etc. is a config change once Polymarket lists them.

## Market Discovery

`discoverUpDownMarkets({ assetSymbol, lookback, lookahead })` walks the
sliding range of expected windows around now, fetches each via Gamma
`/events/slug/{slug}`, parses the response, and returns one
`DiscoveryResult` per window. The collector runs this every 30s.

`upsertMarket` writes the parsed result into `markets`, refreshing
`last_seen_at`, `updated_at`, and `raw_gamma`. The raw payload is preserved
so audit tooling can flag schema drift.

## Polymarket WebSocket

Endpoint: `wss://ws-subscriptions-clob.polymarket.com/ws/market`

After connect, send a `market`-type subscription with `assets_ids` (note:
snake_case, plural) listing every CLOB token id we want orderbook updates
for:

```json
{ "type": "market", "assets_ids": ["<token_id>", "<token_id>", ...] }
```

**Mid-connection subscribes are not supported.** Both re-subscribing an
existing asset_id and adding a new one are rejected with the literal text
frame `INVALID OPERATION`, and the rejected asset_id is silently NOT added
to the server's subscription list. To extend the subscription set, the
client must close the connection and reopen it with the new full set as
the first frame. `PolymarketWsClient.updateSubscriptions` does this
automatically when new asset_ids appear; pure-removal changes are
no-reconnect since old markets stop emitting on their own.

The server emits these event types — wiggler routes each into the in-memory
`BookState` and otherwise discards them. **No raw frames are persisted.**

- `book` — full orderbook snapshot. Replaces the in-memory book. Carries
  `bids`, `asks`, `tick_size`, and a snapshot of `last_trade_price`.
  Top-level `asset_id` identifies which book this snapshot belongs to.
- `price_change` — one or more level deltas inside a `price_changes` array
  (note: plural). **A single frame carries entries for multiple `asset_id`s**
  — each entry has its own `asset_id`, `price`, `side`, `size`, plus optional
  `best_bid` / `best_ask`. There is no top-level `asset_id` on the frame.
  `size: "0"` removes a level. `groupPriceChangesByAsset` splits these into
  per-asset slices that get dispatched to each `BookState`.
- `tick_size_change` — minimum tick size at the price extremes; carries a
  top-level `asset_id`.
- `last_trade_price` — informational; ignored. Trade context arrives in the
  next `book` frame's `last_trade_price` field if needed.

## Book Reconstruction

`BookState` (`src/lib/polymarket/bookState.ts`) maintains one orderbook per
CLOB asset id (one outcome of one market). It applies snapshots and
incremental price changes, exposes top-N levels, computes a deterministic
hash for the top of book, and detects crossed books.

`BookRegistry` is the per-collector map of asset id -> `BookState`. The
coordinator subscribes to every up/down token id for the current and
near-window markets.

## Snapshot Scheduler

`runSnapshotScheduler` (`src/lib/collector/snapshotScheduler.ts`) ticks at
`COLLECTOR_SNAPSHOT_INTERVAL_MS` (default 1s) and writes:

1. one `book_snapshots` + `COLLECTOR_BOOK_DEPTH × 2` `book_levels` rows per
   active (market, outcome) whose `BookState` has received at least one
   snapshot frame.
2. one `asset_price_snapshots` row per configured `priceSymbols` entry,
   holding the latest CEX midpoints + a blended average + per-source
   staleness.

All rows from one tick share an identical `captured_at_ms` so `book_snapshots`
and `asset_price_snapshots` can be joined cleanly on that bigint.

## Auditing

- `audit:latest --asset BTC` — current/next market presence, last book
  snapshot age, complement-price sanity, crossed-book detection, last
  CEX price snapshot freshness, last-5m counts.
- `audit:market <slug>` — per-market coverage: snapshot count vs expected,
  first/last timestamps, resolution state.
- `audit:gaps --asset BTC --since 24h` — missing markets and missing token
  ids over the lookback.
- `audit:book <slug>` — compact time series of best bid/ask per outcome, or
  with `--at <ISO>` the top-N levels at a moment in time.
- `audit:prices --asset BTC --since 1h` — CEX snapshot count, freshness, and
  the most recent per-source snapshot.

Failure thresholds in `audit:latest`:

- `FAIL` if no current market is discovered or last book snapshot is older
  than 3s.
- `WARN` if the next market is missing, last price snapshot is older than 3s,
  either book is crossed, or the complement check fails.

## Known Edge Cases

- Polymarket lists markets a few minutes ahead, so the very next-window slug
  might 404 transiently right after a window rollover. Discovery treats this
  as `not_found` rather than an error and re-checks every 30s.
- The Gamma payload's `event.startDate` and `market.startDate` are creation
  timestamps, not the trading window start. Always use the slug suffix.
- `outcomePrices` on a resolved market shows the final settlement
  (`["1", "0"]` or `["0", "1"]`). `parseGammaEvent` treats the side with
  price `1` as the resolved outcome.
