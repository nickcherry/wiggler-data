import type { CandleSource } from "@wiggler/constants/candles";

/**
 * Maps a wiggler symbol (`BTC`) to the exchange pair string the source's
 * REST endpoint expects. We always quote against USD-pegged stables when
 * the source's spot pair against actual USD doesn't have deep history;
 * Binance.US uses USDT, the others use USD directly.
 */
export function toCoinbasePair(symbol: string): string {
  return `${symbol.toUpperCase()}-USD`;
}
export function fromCoinbasePair(pair: string): string {
  return pair.split("-")[0]?.toUpperCase() ?? pair.toUpperCase();
}

export function toBinancePair(symbol: string): string {
  // Binance.US carries the same spot pairs as Binance.com under USDT quotes.
  return `${symbol.toUpperCase()}USDT`;
}
export function fromBinancePair(pair: string): string {
  const upper = pair.toUpperCase();
  return upper.endsWith("USDT") ? upper.slice(0, -4) : upper;
}

export function toBitstampPair(symbol: string): string {
  // Bitstamp paths are lowercase, e.g. `ohlc/btcusd`.
  return `${symbol.toLowerCase()}usd`;
}
export function fromBitstampPair(pair: string): string {
  const lower = pair.toLowerCase();
  const stripped = lower.endsWith("usd") ? lower.slice(0, -3) : lower;
  return stripped.toUpperCase();
}

const TO_PAIR: Readonly<Record<CandleSource, (s: string) => string>> = {
  coinbase: toCoinbasePair,
  binance: toBinancePair,
  bitstamp: toBitstampPair,
};

/** Returns the source's expected pair string for a wiggler `symbol`. */
export function exchangePair(source: CandleSource, symbol: string): string {
  return TO_PAIR[source](symbol);
}
