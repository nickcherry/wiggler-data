import type { CandleSource, Timeframe } from "@wiggler/constants/candles";

/**
 * Canonical normalized candle. Each `_e8` field is an integer in 1e8 units
 * (matching the `candles` table on disk). `tradeCount` is whatever the
 * source reports (Coinbase doesn't return it; we leave it null there).
 */
export type Candle = Readonly<{
  source: CandleSource;
  symbol: string;
  exchangePair: string;
  timeframe: Timeframe;
  openTimeMs: number;
  openE8: bigint;
  highE8: bigint;
  lowE8: bigint;
  closeE8: bigint;
  volumeE8: bigint | null;
  tradeCount: number | null;
}>;

/**
 * Contract every per-source fetcher implements. The fetcher takes a window
 * `[fromMs, toMs]` and a symbol; it issues paginated REST requests as
 * needed and yields chunks of normalized `Candle`s. Implementations are
 * responsible for respecting their own rate limits.
 */
export type CandleFetcher = (args: {
  symbol: string;
  fromMs: number;
  toMs: number;
  timeframe: Timeframe;
  signal?: AbortSignal;
}) => AsyncIterable<readonly Candle[]>;
