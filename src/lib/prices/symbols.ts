/**
 * Maps a wiggler asset symbol (`BTC`, `ETH`, `SOL`) to the product id
 * Coinbase's `ticker` channel expects (e.g. `BTC-USD`).
 */
export function toCoinbaseProductId(symbol: string): string {
  return `${symbol.toUpperCase()}-USD`;
}

/**
 * Inverse of `toCoinbaseProductId`. Returns the wiggler-canonical symbol
 * portion of a Coinbase product id, falling back to the input itself if the
 * format is unexpected.
 */
export function fromCoinbaseProductId(productId: string): string {
  return productId.split("-")[0]?.toUpperCase() ?? productId.toUpperCase();
}

/**
 * Maps a wiggler asset symbol (`BTC`) to the symbol Binance Spot's
 * `bookTicker` stream uses (`BTCUSDT`). We always pair against USDT.
 */
export function toBinanceSymbol(symbol: string): string {
  return `${symbol.toUpperCase()}USDT`;
}

/**
 * Inverse of `toBinanceSymbol`. Strips the `USDT` suffix from a Binance
 * symbol; returns the input upper-cased if the suffix is missing.
 */
export function fromBinanceSymbol(binanceSymbol: string): string {
  const upper = binanceSymbol.toUpperCase();
  return upper.endsWith("USDT") ? upper.slice(0, -4) : upper;
}

/**
 * Maps a wiggler symbol to Gemini v1 marketdata path segment (`BTCUSD`).
 * Gemini's URL is `wss://api.gemini.com/v1/marketdata/<SYMBOL>?...`.
 */
export function toGeminiSymbol(symbol: string): string {
  return `${symbol.toUpperCase()}USD`;
}

/** Inverse of `toGeminiSymbol`. */
export function fromGeminiSymbol(geminiSymbol: string): string {
  const upper = geminiSymbol.toUpperCase();
  return upper.endsWith("USD") ? upper.slice(0, -3) : upper;
}

/**
 * Maps a wiggler symbol to Bybit Spot's `<SYMBOL>USDT` pair convention.
 */
export function toBybitSymbol(symbol: string): string {
  return `${symbol.toUpperCase()}USDT`;
}

/** Inverse of `toBybitSymbol`. */
export function fromBybitSymbol(bybitSymbol: string): string {
  const upper = bybitSymbol.toUpperCase();
  return upper.endsWith("USDT") ? upper.slice(0, -4) : upper;
}

/**
 * Maps a wiggler symbol to Bitstamp's lowercase channel-suffix convention,
 * e.g. `BTC` -> `btcusd` (used in `order_book_btcusd`).
 */
export function toBitstampSymbol(symbol: string): string {
  return `${symbol.toLowerCase()}usd`;
}

/** Inverse of `toBitstampSymbol`. */
export function fromBitstampSymbol(bitstampSymbol: string): string {
  const lower = bitstampSymbol.toLowerCase();
  const stripped = lower.endsWith("usd") ? lower.slice(0, -3) : lower;
  return stripped.toUpperCase();
}

/**
 * Maps a wiggler symbol to Bitfinex's `t<SYMBOL>USD` pair (the leading `t`
 * marks a trading pair, distinct from funding pairs prefixed with `f`).
 */
export function toBitfinexSymbol(symbol: string): string {
  return `t${symbol.toUpperCase()}USD`;
}

/** Inverse of `toBitfinexSymbol`. */
export function fromBitfinexSymbol(bitfinexSymbol: string): string {
  let pair = bitfinexSymbol.toUpperCase();
  if (pair.startsWith("T")) {pair = pair.slice(1);}
  return pair.endsWith("USD") ? pair.slice(0, -3) : pair;
}

/**
 * Maps a wiggler symbol to Kraken v2's `BTC/USD` pair convention. v2 accepts
 * `BTC` directly (v1 used `XBT/USD`).
 */
export function toKrakenSymbol(symbol: string): string {
  return `${symbol.toUpperCase()}/USD`;
}

/** Inverse of `toKrakenSymbol`. */
export function fromKrakenSymbol(krakenSymbol: string): string {
  return krakenSymbol.split("/")[0]?.toUpperCase() ?? krakenSymbol.toUpperCase();
}
