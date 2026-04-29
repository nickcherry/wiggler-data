# Analysis

The data shape (snapshot-only, single-cadence, joinable on `captured_at_ms`)
is designed to support exactly one analysis question:

> When the *real* BTC price (the blended CEX midpoint) has diverged
> sufficiently from the market's start anchor, with little time left in the
> 5-minute window and adequate Polymarket liquidity available, what is the
> probability that the market resolves in the divergence's direction?

The deliverable from this analysis is a small configuration object — five
numbers — that can drive a live trader without further infrastructure.

```ts
{
  side: "Up" | "Down",          // direction of the bet
  minPctMove: 0.005,             // ≥ 0.5% from start, signed by side
  maxSecondsLeft: 60,            // and ≤ 60s left in the window
  maxEntryPriceE6: 850_000,      // and best ask ≤ 0.85
  minFillableSizeE6: 100_000_000 // and ≥ 100 shares fillable at that ask
}
```

## Concepts

- **Start anchor.** The blended CEX midpoint at the first
  `asset_price_snapshots` row whose `captured_at` is at or after a market's
  `start_ts`. This is "where BTC was when the 5-minute window opened" — the
  line Polymarket judges Up/Down against. Computed on the fly from existing
  data; not cached.
- **Pct move.** `(blended_mid_e8(now) - start_anchor) / start_anchor`. Signed.
  Positive when BTC is above the line, negative below.
- **Seconds left.** `markets.end_ts - book_snapshots.captured_at`.
- **Trigger predicate.** A snapshot tick "fires" when:
  - `seconds_left ≤ maxSecondsLeft`
  - `pct_move × side_sign ≥ minPctMove` (where `side_sign` is +1 for Up, −1 for Down)
  - `best_ask_e6 ≤ maxEntryPriceE6` on the chosen side's book
  - `sum(book_levels.size_e6)` for asks at prices `≤ maxEntryPriceE6` is `≥ minFillableSizeE6`
- **Hit / miss.** A trigger is a "hit" when `markets.resolved_outcome` matches
  `config.side`, otherwise a "miss".
- **PnL per share.** Buy at `best_ask`, hold to expiration. Win pays
  `1 − entry`, loss pays `−entry`. Fees are NOT modeled — account for them
  in the policy threshold.

## Commands

### `analyze:window <slug>`

Per-second timeline of one market. Eyeball test before sweeping parameters.

```
slug:        btc-updown-5m-1777494000
asset:       BTC
window:      2026-04-29T20:20:00Z -> 2026-04-29T20:25:00Z
resolved:    Up
start_price: 75500.00 (anchor at 2026-04-29T20:20:00.123Z)

second  blended       pct%      up_bid up_ask  down_bid down_ask
     0    75500.00   +0.000%    0.50   0.51     0.49     0.50
     1    75503.50   +0.005%    0.50   0.51     0.49     0.50
   ...
   299    75612.40   +0.149%    0.99   1.00     0.00     0.01
```

Confirms:

- The anchor was captured close to `start_ts`.
- `pct_move` and the Polymarket book co-move in the way you'd expect (when
  BTC pushes up, `up_ask` should rise toward 1, `down_ask` should fall).
- Snapshot density is roughly 1/sec (≈ 300 rows for a 5-minute window).

If any of those look wrong, fix it before relying on the backtest.

### `backtest:trigger`

Walks every resolved market and reports aggregate hit rate and mean PnL for
one trigger config.

```
bun wiggler backtest:trigger \
  --side Up \
  --min-pct-move 0.005 \
  --max-seconds-left 60 \
  --max-entry-price 0.85 \
  --min-fill-size 100
```

Output:

```
asset:               BTC
side:                Up
min_pct_move:        0.500%
max_seconds_left:    60
max_entry_price:     0.85
min_fill_size:       100

resolved_markets:    247
triggers:             89
hits:                 76
misses:               13
hit_rate:            85.39%
mean_pnl_per_share:  +0.0731
```

To find a sweet spot, run it across a grid of `(side, min_pct_move,
max_seconds_left, max_entry_price, min_fill_size)` values. Pick the row
whose hit rate × trigger frequency × per-trade PnL clears your edge target
after fees.

## How the SQL works

`runBacktest` is a single CTE-chained query. The work-doing-postgres approach
keeps the backtest fast as data grows:

1. **`anchor`** — one row per resolved market with the start-anchor blended
   midpoint (subselect against `asset_price_snapshots` filtered by
   `captured_at >= m.start_ts`).
2. **`triggers`** — joins `book_snapshots` (filtered to the chosen side) to
   `asset_price_snapshots` on `captured_at_ms`, and to `anchor` on `slug`.
   Computes `pct_move` and `seconds_left`.
3. **`candidates`** — applies the predicate's pure-arithmetic conditions
   (`pct_move`, `seconds_left`, `best_ask`).
4. **`fillable`** — for each candidate, sums `book_levels.size_e6` at the
   ask side under `maxEntryPriceE6`. The PK on `(snapshot_id, side,
   level_index)` makes each subquery a tight index lookup.
5. **`matched`** — drops rows where fill size is insufficient; tags each
   surviving row with hit/miss + per-share PnL.
6. **Aggregate** — counts and PnL sum across `matched`.

## Limitations

- **Fees are not modeled.** Polymarket charges fees on fills. Subtract
  them in your policy or in a future version of the backtest.
- **Slippage is approximated.** The fillable check ensures *some* size at
  or under the price ceiling, but doesn't model what the actual average
  fill price would be for orders that walk the book. Realistic enough for
  triage; not realistic enough for the live trader without a follow-up.
- **Settlement asymmetry.** Polymarket settles against Chainlink BTC/USD.
  Our blended midpoint is a close proxy but not identical. Use a buffer in
  `minPctMove` to absorb the gap.
- **Latency at trigger time.** The signal fires on a snapshot up to one
  cadence tick old. The Polymarket book can move in that interval. For
  the live trader, plan for re-evaluating just before placing an order.
