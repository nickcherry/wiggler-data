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
 * Canonical list of CEX sources we ingest 1-minute candles from. These three
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
 *   - Bitfinex: previously listed here but removed because their per-IP
 *     rate limits make multi-symbol parallel backfills unreliable —
 *     even at 2 concurrent symbols, the public `/v2/candles` endpoint
 *     returns sustained 429s and our 6-attempt exponential-backoff
 *     fetcher couldn't get through. BTC bitfinex data already in
 *     `candles` is left in place; new symbol coverage relies on the
 *     three remaining sources.
 */
export const CANDLE_SOURCES = [
  "coinbase",
  "binance",
  "bitstamp",
] as const;
export type CandleSource = (typeof CANDLE_SOURCES)[number];
