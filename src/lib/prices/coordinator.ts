import { env } from "@wiggler/constants/env";
import { writeHeartbeat } from "@wiggler/lib/collector/heartbeats";
import type { DatabaseClient } from "@wiggler/lib/db/types";
import { logger } from "@wiggler/lib/logging/logger";
import { BinanceBookTickerClient } from "@wiggler/lib/prices/binanceClient";
import { BitfinexBookClient } from "@wiggler/lib/prices/bitfinexClient";
import { BitstampOrderBookClient } from "@wiggler/lib/prices/bitstampClient";
import { BybitOrderbookClient } from "@wiggler/lib/prices/bybitClient";
import { CoinbaseTickerClient } from "@wiggler/lib/prices/coinbaseClient";
import { GeminiTopOfBookClient } from "@wiggler/lib/prices/geminiClient";
import { KrakenBookClient } from "@wiggler/lib/prices/krakenClient";
import { CexPriceRegistry } from "@wiggler/lib/prices/state";
import type { PriceFeedClient, PriceSource } from "@wiggler/lib/prices/types";
import { sleep } from "@wiggler/lib/util/sleep";

const HEARTBEAT_INTERVAL_MS = 5_000;

export type PriceCoordinatorHandle = Readonly<{
  /** Mutable in-memory state read by the snapshot scheduler. */
  registry: CexPriceRegistry;
  /** Resolves once every client lifecycle has shut down. */
  done: Promise<void>;
}>;

export type PriceCoordinatorOptions = Readonly<{
  symbols: readonly string[];
  signal: AbortSignal;
  /** Shared db (for heartbeat writes). */
  db: DatabaseClient;
  runId: string;
}>;

/**
 * Runs every CEX price-feed client in parallel and updates `CexPriceRegistry`
 * on every inbound tick. Returns the registry synchronously so the caller can
 * wire it into the snapshot scheduler.
 *
 * Persistence is the snapshot scheduler's job. This coordinator never writes
 * tick data to the database; it only writes its own heartbeat with per-source
 * status and last-tick timestamps for `audit:health` style checks.
 */
export function startPriceCoordinator(
  options: PriceCoordinatorOptions,
): PriceCoordinatorHandle {
  const registry = new CexPriceRegistry();
  const log = logger.child({
    component: "prices",
    symbols: options.symbols.join(","),
  });

  if (options.symbols.length === 0) {
    log.warn("price coordinator started with empty symbol list", {});
    return { registry, done: Promise.resolve() };
  }

  log.info("price coordinator started", {});

  const sharedTick = (tick: Parameters<CexPriceRegistry["record"]>[0]): void => {
    registry.record(tick);
  };

  const clients: ReadonlyArray<{ source: PriceSource; client: PriceFeedClient }> = [
    {
      source: "coinbase",
      client: new CoinbaseTickerClient({
        url: env.coinbaseWsUrl,
        symbols: options.symbols,
        signal: options.signal,
        onTick: sharedTick,
        onOpen: () => log.info("coinbase ws connected", {}),
        onClose: (code, reason) => log.warn("coinbase ws closed", { code, reason }),
        onError: (error) => log.warn("coinbase ws error", { message: error.message }),
      }),
    },
    {
      source: "binance",
      client: new BinanceBookTickerClient({
        url: env.binanceWsUrl,
        symbols: options.symbols,
        signal: options.signal,
        onTick: sharedTick,
        onOpen: () => log.info("binance ws connected", {}),
        onClose: (code, reason) => log.warn("binance ws closed", { code, reason }),
        onError: (error) => log.warn("binance ws error", { message: error.message }),
      }),
    },
    {
      source: "gemini",
      client: new GeminiTopOfBookClient({
        baseUrl: env.geminiWsBaseUrl,
        symbols: options.symbols,
        signal: options.signal,
        onTick: sharedTick,
        onOpen: (symbol) => log.info("gemini ws connected", { symbol }),
        onClose: (symbol, code, reason) =>
          log.warn("gemini ws closed", { symbol, code, reason }),
        onError: (error) => log.warn("gemini ws error", { message: error.message }),
      }),
    },
    {
      source: "bybit",
      client: new BybitOrderbookClient({
        url: env.bybitWsUrl,
        symbols: options.symbols,
        signal: options.signal,
        onTick: sharedTick,
        onOpen: () => log.info("bybit ws connected", {}),
        onClose: (code, reason) => log.warn("bybit ws closed", { code, reason }),
        onError: (error) => log.warn("bybit ws error", { message: error.message }),
      }),
    },
    {
      source: "bitstamp",
      client: new BitstampOrderBookClient({
        url: env.bitstampWsUrl,
        symbols: options.symbols,
        signal: options.signal,
        onTick: sharedTick,
        onOpen: () => log.info("bitstamp ws connected", {}),
        onClose: (code, reason) => log.warn("bitstamp ws closed", { code, reason }),
        onError: (error) => log.warn("bitstamp ws error", { message: error.message }),
      }),
    },
    {
      source: "bitfinex",
      client: new BitfinexBookClient({
        url: env.bitfinexWsUrl,
        symbols: options.symbols,
        signal: options.signal,
        onTick: sharedTick,
        onOpen: () => log.info("bitfinex ws connected", {}),
        onClose: (code, reason) => log.warn("bitfinex ws closed", { code, reason }),
        onError: (error) => log.warn("bitfinex ws error", { message: error.message }),
      }),
    },
    {
      source: "kraken",
      client: new KrakenBookClient({
        url: env.krakenWsUrl,
        symbols: options.symbols,
        signal: options.signal,
        onTick: sharedTick,
        onOpen: () => log.info("kraken ws connected", {}),
        onClose: (code, reason) => log.warn("kraken ws closed", { code, reason }),
        onError: (error) => log.warn("kraken ws error", { message: error.message }),
      }),
    },
  ];

  for (const { client } of clients) {client.start();}

  const stopHeartbeat = startHeartbeatLoop({
    db: options.db,
    runId: options.runId,
    clients,
    signal: options.signal,
  });

  const done = new Promise<void>((resolve) => {
    if (options.signal.aborted) {
      resolve();
      return;
    }
    options.signal.addEventListener("abort", () => resolve(), { once: true });
  }).then(() => {
    stopHeartbeat();
    for (const { client } of clients) {client.stop();}
    log.info("price coordinator stopped", {});
  });

  return { registry, done };
}

function startHeartbeatLoop(args: {
  db: DatabaseClient;
  runId: string;
  clients: ReadonlyArray<{ source: PriceSource; client: PriceFeedClient }>;
  signal: AbortSignal;
}): () => void {
  let stopped = false;
  const tick = async (): Promise<void> => {
    while (!stopped && !args.signal.aborted) {
      try {
        const detailsJson: Record<string, unknown> = {};
        let anyConnected = false;
        for (const { source, client } of args.clients) {
          detailsJson[`${source}Status`] = client.status;
          detailsJson[`${source}LastTickAtMs`] = client.lastTickAtMs;
          if (client.status === "connected") {anyConnected = true;}
        }
        await writeHeartbeat(args.db, {
          runId: args.runId,
          component: "prices",
          status: anyConnected ? "ok" : "degraded",
          detailsJson,
        });
      } catch (error) {
        logger.warn("price heartbeat write failed", {
          component: "prices",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        await sleep(HEARTBEAT_INTERVAL_MS, args.signal);
      } catch {
        return;
      }
    }
  };
  void tick();
  return (): void => {
    stopped = true;
  };
}
