const defaultDatabaseUrl = "postgres://localhost:5432/wiggler";
const defaultCoinbaseRestBaseUrl = "https://api.exchange.coinbase.com";
// Binance.com is geo-blocked from the US (HTTP 451). Default to Binance.US.
const defaultBinanceRestBaseUrl = "https://api.binance.us";
const defaultBitstampRestBaseUrl = "https://www.bitstamp.net";

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

function parseSymbolList(
  raw: string | undefined,
  fallback: readonly string[],
): readonly string[] {
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
 * Canonical environment dependency access for the application. Every
 * `process.env` read in the codebase happens through this object so the
 * full set of external dependencies is discoverable in one file.
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
  get defaultAsset(): string {
    return (process.env.DEFAULT_ASSET ?? "BTC").toUpperCase();
  },
  get defaultSymbols(): readonly string[] {
    return parseSymbolList(process.env.DEFAULT_SYMBOLS, [this.defaultAsset]);
  },
  get coinbaseRestBaseUrl(): string {
    return process.env.COINBASE_REST_BASE_URL ?? defaultCoinbaseRestBaseUrl;
  },
  get binanceRestBaseUrl(): string {
    return process.env.BINANCE_REST_BASE_URL ?? defaultBinanceRestBaseUrl;
  },
  get bitstampRestBaseUrl(): string {
    return process.env.BITSTAMP_REST_BASE_URL ?? defaultBitstampRestBaseUrl;
  },
  get logLevel(): string {
    return process.env.LOG_LEVEL ?? "info";
  },
} as const;
