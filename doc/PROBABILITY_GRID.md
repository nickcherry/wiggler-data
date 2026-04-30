# Probability Grid

`candles:win-prob-grid` is the pipeline stage that produces the
deliverable: a calibrated `P(current_side_wins | state)` grid that
wiggler reads at runtime to decide when to trade Polymarket fixed-window
up/down markets.

## What problem this solves

Unconditional movement-percentile tables (`candles:distributions`)
answer the wrong question. They tell you "how big are typical 5-minute
moves?" The trade question is:

> Given that I'm currently `d_bps` away from the 5-minute start price,
> with `τ` seconds left, how often does the current side actually
> survive to win?

That's a conditional, not a marginal — and it's what wiggler needs to
compare against the executable Polymarket ask after fees.

The output of this stage is a calibrated probability grid, indexed by
`(remaining_sec, vol_bin, abs_d_bps_bucket)`, where each cell stores
the empirical win count and a Wilson 95% one-sided lower bound on the
true rate.

## Config schema (`wiggler-prob-grid-v1`)

```jsonc
{
  "version": "wiggler-prob-grid-v1",
  "asset": "BTC",
  "market_type": "up_down",
  "interval_sec": 300,
  "anchor_mode": "rolling",          // or "boundary"

  // Provenance — every field is reproducible from these.
  "generated_at_iso": "2026-04-30T12:34:56.000Z",
  "git": { "commit_sha": "<sha>", "dirty": false },
  "training_input": {
    "label_source": "vwap",
    "label_source_note": "wiggler-data cross-source 1m VWAP across coinbase, binance, bitstamp. Used as a Chainlink proxy: at training time we have no historical Chainlink data, so basis risk versus the live resolution feed is unmeasured.",
    "rowcount": 2_098_452,
    "window_start_ms": 1745020800000,
    "window_end_ms":   1777557120000
  },
  "resolution_source": {
    "intended": { "name": "Chainlink Data Streams", "symbol": "BTC/USD" },
    "proxy_basis_risk": "unmeasured"
  },
  "config_hash": "<sha256 of the bucket array>",

  // Bucket definitions — wiggler must apply identical binning at runtime.
  "abs_d_bps_boundaries": [0, 2, 4, 6, 8, 10, 15, 20, 25, 30, 40, 50, 75],
  "remaining_sec_buckets": [60, 120, 180, 240],
  "vol_bins": {
    "method": "training_terciles_with_p90_tail",
    "thresholds_bps_per_sqrt_min": {
      "lowMaxBpsPerSqrtMin":    5.20,
      "normalMaxBpsPerSqrtMin": 8.74,
      "highMaxBpsPerSqrtMin":  14.51
    },
    "vol_lookback_min": 30
  },

  // Risk + fee defaults. Every value is a default for wiggler — wiggler
  // is free to override at runtime.
  "fee": {
    "formula": "fee = shares * fee_rate * price * (1 - price)",
    "taker_fee_rate": 0.072
  },
  "risk_defaults": {
    "min_remaining_sec_to_trade": 60,
    "min_edge_probability": 0.015,
    "min_bucket_count": 500,
    "max_position_usdc": 250,
    "kelly_fraction": 0.1
  },

  // Aggregate counts (sanity).
  "totals": {
    "decision_state_rows": 2_098_452,
    "up_win_anchors":  262_911,
    "down_win_anchors": 261_440
  },

  // The grid itself.
  "grid": [
    {
      "remaining_sec": 60,
      "vol_bin": "normal",
      "abs_d_bps_min": 20,
      "abs_d_bps_max": 25,
      "count": 1842,
      "wins": 1776,
      "p_win": 0.964169,
      "p_win_lower": 0.954982
    },
    // ...
  ]
}
```

The file lives at
`tmp/win-prob-grid/{SYMBOL}_{TF}_{INTERVAL}s_{LABEL_SOURCE}_{anchor_mode}.json`
and is per-config cached: a fingerprint of the upstream candle data is
written into the file and compared on read, so re-running with the same
data is sub-second.

## How the grid is built

1. Stream close prices for the chosen training source — default `vwap`
   (the cross-source aggregate from `candle_vwap`). Used as a Chainlink
   proxy because we don't have historical Chainlink Data Streams data
   yet. The basis risk versus live Chainlink is **unmeasured** and
   carried into the config so wiggler inherits the warning.

2. For every minute that can serve as an interval start (rolling
   anchors — `anchor_step_min=1` by default; can restrict to true
   5-minute boundaries with `--anchor-step-min 5`), generate one
   decision row per integer-minute boundary inside the interval:
   `remaining_sec ∈ {60, 120, 180, 240}`.

3. At each decision moment, compute:
   - `d_bps = bps(current_price - line_price)`, where `current_side` is
     Up when `d_bps ≥ 0` (tie goes to Up — matches Polymarket's
     resolution rule).
   - `recent_vol_bps_per_sqrt_min` = RMS of the last 30 1-minute returns.
   - `winning_side` = Up when `final_price ≥ line_price`, else Down.

4. Pool Up and Down trades into a single `current_side_won` count per
   bucket (assuming up/down symmetry — measurable skew can be carved
   out later by splitting the grid).

5. After scanning, derive the vol-bin thresholds from the empirical
   distribution of decision-time `recent_vol` values (33/67/90
   percentile split → low/normal/high/extreme). Apply the same binning
   at runtime in wiggler.

6. For each bucket, emit `count`, `wins`, `p_win = wins/count`, and a
   95% one-sided **Wilson lower bound** `p_win_lower`. Wiggler trades
   against the lower bound, never the point estimate — small buckets
   look certain at the point estimate (17/17 = 100%) but their lower
   bound is correctly modest.

## Candle-timestamp invariant (read this if you touch the math)

The math has a sharp edge: candle close prices come from the **end** of
their bar, so an off-by-one on indices silently leaks future data into
your decision rows.

In our schema, a candle with `open_time = T` covers `[T, T + 60s)` and
its close is **first knowable at `T + 60s`** — never sooner.

The grid models a market that spans the wall-clock interval whose start
moment lines up with the first-knowable moment of the anchor candle.
With `i` the anchor index in the dense `closeAt` array:

| variable                              | source                                | knowable at         |
|---------------------------------------|----------------------------------------|---------------------|
| line price (price at market start)    | `closeAt[i]`                           | `baseMs + (i+1)·60s` |
| final price (price at market end)     | `closeAt[i + intervalMin]`             | `baseMs + (i+1+intervalMin)·60s` |
| current price at decision time `T_d`  | `closeAt[i + (intervalMin − rem/60)]`  | `T_d`               |

In particular, with `intervalMin = 5` and `remaining_sec = 60`, the
current price comes from `closeAt[i + 4]` (knowable exactly at the
decision moment) — **not** `closeAt[i + 5]`, which is the resolution
price and only becomes knowable when the market ends.

A regression test (`no lookahead bias: resolution-bar price never
enters decision rows` in `winProbGrid.test.ts`) locks this in. If you
adjust the offsets, re-derive the table above and re-run that test.

## Known v1 limitations

- **No historical Chainlink data.** Training labels use the
  cross-source `vwap` aggregate as a proxy; basis risk versus live
  Chainlink is unmeasured and tagged in the config. Wiggler should log
  a live proxy-vs-Chainlink basis at runtime and refuse to trade when
  the basis is large.
- **Decision granularity capped at 60s.** 1-minute candles can't model
  the 0–59s remaining window. The config's
  `risk_defaults.min_remaining_sec_to_trade = 60` keeps wiggler out of
  it; consider tightening to 75–90s until sub-minute data is ingested.
- **Aggregate `range_bps`, `max_up_move_bps`, `max_down_move_bps` for
  `vwap` are degenerate.** The cross-source VWAP is a single price per
  minute — there's no aggregate high/low to compute true ranges. The
  win-prob grid only uses close-to-close labels and current-distance
  features, so it isn't affected. Don't use the `vwap` row of
  `candles:distributions` for anything that depends on the wick
  metrics until the aggregation is fixed.
- **Up/Down symmetry assumed.** Trades are pooled by `current_side_won`.
  If meaningful skew turns up in calibration, split the grid in two.
- **No order-book backtest.** We don't have historical Polymarket order
  books. The opportunity report tells you whether the model would
  produce enough high-confidence signals — execution-quality estimates
  wait until live order-book data exists.

## Validation workflow

```bash
# 1. Train on rolling anchors (default — max sample size).
bun wiggler candles:win-prob-grid

# 2. Validate on true 5-minute market boundaries — same math, smaller
#    sample, but no rolling-anchor overlap. Trust this when the two
#    grids disagree on the high-confidence cells.
bun wiggler candles:win-prob-grid --anchor-step-min 5

# 3. Calibration: predicted-vs-realized by p_win_lower decile.
#    Realized < predicted on any populated bin → over-confidence.
bun wiggler candles:calibration-report
bun wiggler candles:calibration-report --anchor-mode boundary

# 4. Opportunity: would the model produce enough tradable signals?
bun wiggler candles:opportunity-report
```

## What wiggler does with the config

```text
1. Read live Polymarket market metadata (start/end, token IDs).
2. Read live Chainlink price (or robust exchange-aggregate proxy).
3. Compute d_bps, remaining_sec, recent_vol_bps_per_sqrt_min.
4. Skip if remaining_sec < risk_defaults.min_remaining_sec_to_trade.
5. Look up p_win_lower in grid[remaining_sec, vol_bin, abs_d_bps_bucket].
6. Skip if count < risk_defaults.min_bucket_count.
7. Read live Polymarket order book; compute all-in cost per ask level:
     all_in = ask + fee_rate * ask * (1 - ask)
8. Buy levels where p_win_lower - all_in >= risk_defaults.min_edge_probability,
   sized via fractional Kelly with hard caps from risk_defaults.
```

Every step's data and threshold lives in this config.
