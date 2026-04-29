export type PriceSource =
  | "coinbase"
  | "binance"
  | "gemini"
  | "bybit"
  | "bitstamp"
  | "bitfinex"
  | "kraken";

/** Ordered list of every source the collector tries to ingest, used for
 *  iteration in the snapshot writer, audit commands, and tests. */
export const PRICE_SOURCES: readonly PriceSource[] = [
  "coinbase",
  "binance",
  "gemini",
  "bybit",
  "bitstamp",
  "bitfinex",
  "kraken",
] as const;

/** Common shape every per-exchange WS client exposes so the coordinator
 *  can drive their lifecycle and heartbeat status uniformly. */
export type PriceFeedClientStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "stopped";

export interface PriceFeedClient {
  start(): void;
  stop(): void;
  readonly status: PriceFeedClientStatus;
  readonly lastTickAtMs: number | null;
}

/**
 * Normalized price tick produced by either of the price-feed WS clients.
 * `price_e8` is the midpoint when both sides are available, otherwise null.
 */
export type PriceTick = Readonly<{
  source: PriceSource;
  symbol: string;
  exchangePair: string;
  receivedAtMs: number;
  eventMs: number | null;
  priceE8: bigint | null;
  bidE8: bigint | null;
  askE8: bigint | null;
  bidSizeE8: bigint | null;
  askSizeE8: bigint | null;
  sequence: bigint | null;
  raw: unknown;
}>;
