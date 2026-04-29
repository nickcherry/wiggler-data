const defaultDatabaseUrl = "postgres://localhost:5432/wiggler";
const defaultGammaBaseUrl = "https://gamma-api.polymarket.com";
const defaultClobBaseUrl = "https://clob.polymarket.com";
const defaultPolymarketWsUrl = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const defaultCoinbaseWsUrl = "wss://ws-feed.exchange.coinbase.com";
// Binance.com is geo-blocked from the US (HTTP 451 on the WS handshake).
// Default to Binance.US, which serves identical bookTicker frames.
const defaultBinanceWsUrl = "wss://stream.binance.us:9443";
// Gemini v1 marketdata; per-symbol path. The query string requesting only
// top-of-book change events is appended by the client at subscribe time.
const defaultGeminiWsBaseUrl = "wss://api.gemini.com/v1/marketdata";
const defaultBybitWsUrl = "wss://stream.bybit.com/v5/public/spot";
const defaultBitstampWsUrl = "wss://ws.bitstamp.net";
const defaultBitfinexWsUrl = "wss://api-pub.bitfinex.com/ws/2";
const defaultKrakenWsUrl = "wss://ws.kraken.com/v2";

function parsePositiveInt(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function parseSymbolList(raw: string | undefined, fallback: readonly string[]): readonly string[] {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parts = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : fallback;
}

/**
 * Canonical environment dependency access for the application.
 */
export const env = {
  get databaseUrl(): string {
    return process.env.DATABASE_URL ?? defaultDatabaseUrl;
  },
  get databasePoolMax(): number | undefined {
    return parsePositiveInt(process.env.DATABASE_POOL_MAX, "DATABASE_POOL_MAX");
  },
  get processEnv(): NodeJS.ProcessEnv {
    return process.env;
  },
  get terminalType(): string | undefined {
    return process.env.TERM;
  },
  get gammaBaseUrl(): string {
    return process.env.POLYMARKET_GAMMA_BASE_URL ?? defaultGammaBaseUrl;
  },
  get clobBaseUrl(): string {
    return process.env.POLYMARKET_CLOB_BASE_URL ?? defaultClobBaseUrl;
  },
  get polymarketWsUrl(): string {
    return process.env.POLYMARKET_WS_URL ?? defaultPolymarketWsUrl;
  },
  get defaultAsset(): string {
    return (process.env.DEFAULT_ASSET ?? "BTC").toUpperCase();
  },
  get priceSymbols(): readonly string[] {
    return parseSymbolList(process.env.PRICE_SYMBOLS, [this.defaultAsset]);
  },
  get coinbaseWsUrl(): string {
    return process.env.COINBASE_WS_URL ?? defaultCoinbaseWsUrl;
  },
  get binanceWsUrl(): string {
    return process.env.BINANCE_WS_URL ?? defaultBinanceWsUrl;
  },
  get geminiWsBaseUrl(): string {
    return process.env.GEMINI_WS_BASE_URL ?? defaultGeminiWsBaseUrl;
  },
  get bybitWsUrl(): string {
    return process.env.BYBIT_WS_URL ?? defaultBybitWsUrl;
  },
  get bitstampWsUrl(): string {
    return process.env.BITSTAMP_WS_URL ?? defaultBitstampWsUrl;
  },
  get bitfinexWsUrl(): string {
    return process.env.BITFINEX_WS_URL ?? defaultBitfinexWsUrl;
  },
  get krakenWsUrl(): string {
    return process.env.KRAKEN_WS_URL ?? defaultKrakenWsUrl;
  },
  get collectorSnapshotIntervalMs(): number {
    return (
      parsePositiveInt(
        process.env.COLLECTOR_SNAPSHOT_INTERVAL_MS,
        "COLLECTOR_SNAPSHOT_INTERVAL_MS",
      ) ?? 1000
    );
  },
  get collectorBookDepth(): number {
    return (
      parsePositiveInt(process.env.COLLECTOR_BOOK_DEPTH, "COLLECTOR_BOOK_DEPTH") ?? 20
    );
  },
  get logLevel(): string {
    return process.env.LOG_LEVEL ?? "info";
  },
} as const;
