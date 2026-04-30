import type { CandleSource } from "@wiggler/constants/candles";
import { fetchBinanceCandles } from "@wiggler/lib/candles/sources/binance";
import { fetchBitfinexCandles } from "@wiggler/lib/candles/sources/bitfinex";
import { fetchBitstampCandles } from "@wiggler/lib/candles/sources/bitstamp";
import { fetchCoinbaseCandles } from "@wiggler/lib/candles/sources/coinbase";
import type { CandleFetcher } from "@wiggler/lib/candles/types";

/**
 * Resolves a `CandleSource` enum value to its fetcher implementation.
 * Adding a new source means adding the fetcher file under `sources/`,
 * appending the source name to `CANDLE_SOURCES`, and adding the entry
 * here — nothing else changes in the orchestrator.
 */
export const FETCHERS: Readonly<Record<CandleSource, CandleFetcher>> = {
  coinbase: fetchCoinbaseCandles,
  binance: fetchBinanceCandles,
  bitstamp: fetchBitstampCandles,
  bitfinex: fetchBitfinexCandles,
};
