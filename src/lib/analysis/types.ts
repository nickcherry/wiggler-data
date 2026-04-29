/** Side of the Up/Down market the backtest is evaluating triggers for. */
export type Side = "Up" | "Down";

/**
 * One row of the per-second time series used by `analyze:window`. All prices
 * are integer-scaled (e6 for Polymarket probabilities, e8 for asset price)
 * so the consumer formats them as needed.
 */
export type WindowTimeSeriesRow = Readonly<{
  capturedAtMs: number;
  capturedAt: Date;
  /** Whole seconds since `markets.start_ts`. Negative when the snapshot precedes start_ts. */
  secondsSinceStart: number;
  /** Whole seconds remaining until `markets.end_ts`. */
  secondsLeft: number;
  /** Latest blended CEX midpoint at this tick (1e8 scale). */
  blendedMidE8: bigint | null;
  /**
   * Signed fractional move from the market's start anchor.
   * `(blendedMidE8 - startAnchorE8) / startAnchorE8`. Null if either side is missing.
   */
  pctMove: number | null;
  /** Polymarket Up share's best bid/ask at this tick (1e6 scale). */
  upBidE6: bigint | null;
  upAskE6: bigint | null;
  /** Polymarket Down share's best bid/ask at this tick (1e6 scale). */
  downBidE6: bigint | null;
  downAskE6: bigint | null;
}>;

/** Anchor for a market's "where did BTC start" reference. */
export type StartAnchor = Readonly<{
  /** Blended midpoint at the snapshot closest to (and at or after) `start_ts`. */
  blendedMidE8: bigint;
  /** Wall-clock of the chosen anchor snapshot (drift from start_ts is at most one cadence tick). */
  anchorAt: Date;
}>;

/**
 * Trigger configuration evaluated by `backtest:trigger` and (eventually) the
 * live trader. Five numbers — that's the entire trade rule.
 */
export type TriggerConfig = Readonly<{
  side: Side;
  /** Minimum absolute price move from the start anchor, expressed as a fraction. e.g. 0.005 = 0.5%. */
  minPctMove: number;
  /** Maximum seconds remaining in the window for the trigger to be valid. */
  maxSecondsLeft: number;
  /** Maximum entry price (per share) on the chosen side, 1e6 scale. e.g. 850_000 = 0.85. */
  maxEntryPriceE6: bigint;
  /** Minimum size available at or below `maxEntryPriceE6` on the entry side, 1e6 scale. */
  minFillableSizeE6: bigint;
}>;

/** One row of backtest output corresponding to a single (config × pool) evaluation. */
export type BacktestResult = Readonly<{
  config: TriggerConfig;
  /** Number of resolved markets considered. */
  resolvedMarkets: number;
  /** Number of (market, second) pairs where the predicate fired. */
  triggers: number;
  /** Triggers whose `resolved_outcome` matches `config.side`. */
  hits: number;
  /** Triggers whose `resolved_outcome` is the opposite side. */
  misses: number;
  /** hits / triggers as a fraction. Null when `triggers === 0`. */
  hitRate: number | null;
  /**
   * Mean PnL per share assuming buy at `best_ask` for `side` and hold to expiration.
   * Win pays `1 - entry`, loss pays `-entry`. Fees are NOT deducted; account for them in policy.
   * Null when `triggers === 0`.
   */
  meanPnlPerShare: number | null;
}>;
