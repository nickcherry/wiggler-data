/**
 * Supported candle timeframes. Phase 1 ingests `1m`; the column on
 * `candles` accepts any of these so coarser timeframes can be added later
 * without a migration.
 */
export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/**
 * Length of each timeframe in milliseconds. Used by the sync loop to
 * paginate request windows and detect coverage gaps.
 */
export const TIMEFRAME_MS: Readonly<Record<Timeframe, number>> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

/**
 * Canonical list of CEX sources we ingest 1-minute candles from. These four
 * support deep historical 1m history (≥1 year) via REST and are reachable
 * from US IPs.
 *
 * Excluded:
 *   - Kraken / Gemini: public OHLC endpoints only return the most recent
 *     ~12 hours / ~1 day of 1m data. Useless for a 1-year backfill.
 *   - Bybit: CloudFront blocks US IPs (HTTP 403, "configured to block
 *     access from your country"). Bybit operates no US entity / fallback
 *     host comparable to Binance.US. Add support if/when running outside
 *     the US becomes a goal.
 */
export const CANDLE_SOURCES = [
  "coinbase",
  "binance",
  "bitstamp",
  "bitfinex",
] as const;
export type CandleSource = (typeof CANDLE_SOURCES)[number];
