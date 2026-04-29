import { randomUUID } from "node:crypto";

import { env } from "@wiggler/constants/env";
import { writeHeartbeat } from "@wiggler/lib/collector/heartbeats";
import {
  finishCollectorRun,
  startCollectorRun,
} from "@wiggler/lib/collector/runs";
import {
  runSnapshotScheduler,
  type SubscriptionKey,
  type SubscriptionView,
} from "@wiggler/lib/collector/snapshotScheduler";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import type { DatabaseClient } from "@wiggler/lib/db/types";
import { logger } from "@wiggler/lib/logging/logger";
import { BookRegistry } from "@wiggler/lib/polymarket/bookRegistry";
import { discoverUpDownMarkets } from "@wiggler/lib/polymarket/marketDiscovery";
import type { ParsedMarket } from "@wiggler/lib/polymarket/types";
import { upsertMarket } from "@wiggler/lib/polymarket/upsertMarket";
import { PolymarketWsClient } from "@wiggler/lib/polymarket/wsClient";
import {
  groupPriceChangesByAsset,
  tryParseWsEvent,
} from "@wiggler/lib/polymarket/wsEvents";
import {
  type PriceCoordinatorHandle,
  startPriceCoordinator,
} from "@wiggler/lib/prices/coordinator";
import { CexPriceRegistry } from "@wiggler/lib/prices/state";
import { sleep } from "@wiggler/lib/util/sleep";

const HEARTBEAT_INTERVAL_MS = 5_000;
const DISCOVERY_INTERVAL_MS = 30_000;
const ASSET_CONTEXT_LOOKBACK = 1;
const ASSET_CONTEXT_LOOKAHEAD = 2;

export type CoordinatorOptions = Readonly<{
  assetSymbol: string;
  /** Symbols whose underlying CEX prices should be snapshotted. Defaults to [assetSymbol]. */
  priceSymbols?: readonly string[];
  /** When true, skip the CEX price coordinator. Used by polymarket-only runs. */
  disablePriceCollection?: boolean;
  signal: AbortSignal;
}>;

/**
 * Top-level wiggler collector. Owns market discovery, the Polymarket WS
 * client, the in-memory book + CEX price registries, the snapshot scheduler,
 * and heartbeat reporting.
 *
 * Persistence is exclusively snapshot-based. Polymarket WS frames update
 * `BookState` in memory; CEX WS ticks update `CexPriceRegistry` in memory.
 * Once per `COLLECTOR_SNAPSHOT_INTERVAL_MS` the scheduler captures both as
 * `book_snapshots` + `asset_price_snapshots` rows that share the same
 * `captured_at_ms`.
 */
export async function runCoordinator(options: CoordinatorOptions): Promise<void> {
  const runId = randomUUID();
  const db = createDatabase();
  const bookRegistry = new BookRegistry();
  const knownMarkets = new Map<string, ParsedMarket>();
  const priceSymbols = options.priceSymbols ?? [options.assetSymbol];

  const log = logger.child({
    component: "coordinator",
    run_id: runId,
    asset: options.assetSymbol,
  });
  log.info("collector started", {});

  await startCollectorRun(db, {
    runId,
    assetSymbol: options.assetSymbol,
    mode: options.disablePriceCollection ? "polymarket-only" : "polymarket+prices",
    config: {
      depth: env.collectorBookDepth,
      intervalMs: env.collectorSnapshotIntervalMs,
      priceSymbols,
    },
  });

  // CEX price state. When the price coordinator is disabled we still
  // construct an empty registry so the snapshot scheduler can record
  // null-everywhere asset price rows; that keeps `captured_at_ms` joins
  // simple regardless of run mode.
  let priceHandle: PriceCoordinatorHandle | null = null;
  if (!options.disablePriceCollection) {
    priceHandle = startPriceCoordinator({
      symbols: priceSymbols,
      signal: options.signal,
      db,
      runId,
    });
  }
  const priceRegistry = priceHandle?.registry ?? new CexPriceRegistry();

  const ws = new PolymarketWsClient({
    onOpen: () => {
      log.info("ws connected", {});
    },
    onClose: (code, reason) => {
      // Code 1000 = normal closure (e.g. our planned cycle for a new
      // subscription). Anything else gets a warn so genuine drops stand out.
      if (code === 1000) {
        log.info("ws closed", { code, reason });
      } else {
        log.warn("ws closed", { code, reason });
      }
    },
    onError: (error) => {
      log.warn("ws error", { message: error.message });
    },
    onMessage: (raw, receivedAtMs) => {
      handleWsMessage({ raw, receivedAtMs, registry: bookRegistry });
    },
  });

  const discoveryStop = startDiscoveryLoop({
    db,
    options,
    ws,
    knownMarkets,
    log,
  });

  const heartbeatStop = startHeartbeatLoop({
    db,
    runId,
    ws,
    registry: bookRegistry,
    options,
  });

  ws.start([], options.signal);

  let runError: string | null = null;
  try {
    await runSnapshotScheduler({
      db,
      bookRegistry,
      priceRegistry,
      priceSymbols,
      depth: env.collectorBookDepth,
      intervalMs: env.collectorSnapshotIntervalMs,
      signal: options.signal,
      getSubscriptions: () => buildSubscriptions(knownMarkets),
    });
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error);
    log.error("scheduler exited with error", { message: runError });
  } finally {
    discoveryStop();
    heartbeatStop();
    ws.stop();
    if (priceHandle) {
      await priceHandle.done;
    }
    await finishCollectorRun(db, {
      runId,
      status: runError ? "error" : "stopped",
      error: runError,
    });
    await destroyDatabase(db);
    log.info("collector stopped", { error: runError });
  }
}

/**
 * Routes a single inbound Polymarket WS frame to the in-memory book state.
 * Trades and unknown event types are ignored — wiggler does not persist
 * per-event data; the snapshot scheduler captures the resulting book state
 * on its own cadence.
 */
function handleWsMessage(args: {
  raw: unknown;
  receivedAtMs: number;
  registry: BookRegistry;
}): void {
  const typed = tryParseWsEvent(args.raw);
  if (!typed) {
    return;
  }
  switch (typed.event_type) {
    case "book": {
      const book = args.registry.getOrCreate(typed.asset_id);
      book.applySnapshot(typed, args.receivedAtMs);
      break;
    }
    case "price_change": {
      const slices = groupPriceChangesByAsset(typed);
      for (const [assetId, slice] of slices) {
        const book = args.registry.getOrCreate(assetId);
        book.applyPriceChange(slice, args.receivedAtMs);
      }
      break;
    }
    case "tick_size_change": {
      const book = args.registry.getOrCreate(typed.asset_id);
      book.applyTickSizeChange(typed, args.receivedAtMs);
      break;
    }
    case "last_trade_price":
      // Trades inform the book's last_trade_price implicitly via the next
      // `book` frame. We do not persist trade prints in the snapshot model.
      break;
  }
}

function startDiscoveryLoop(args: {
  db: DatabaseClient;
  options: CoordinatorOptions;
  ws: PolymarketWsClient;
  knownMarkets: Map<string, ParsedMarket>;
  log: ReturnType<typeof logger.child>;
}): () => void {
  let stopped = false;

  const tick = async (): Promise<void> => {
    while (!stopped && !args.options.signal.aborted) {
      try {
        await runDiscoveryOnce(args);
      } catch (error) {
        args.log.warn("discovery tick failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        await sleep(DISCOVERY_INTERVAL_MS, args.options.signal);
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

async function runDiscoveryOnce(args: {
  db: DatabaseClient;
  options: CoordinatorOptions;
  ws: PolymarketWsClient;
  knownMarkets: Map<string, ParsedMarket>;
  log: ReturnType<typeof logger.child>;
}): Promise<void> {
  const results = await discoverUpDownMarkets({
    assetSymbol: args.options.assetSymbol,
    lookback: ASSET_CONTEXT_LOOKBACK,
    lookahead: ASSET_CONTEXT_LOOKAHEAD,
    signal: args.options.signal,
  });

  for (const result of results) {
    if (result.status !== "ok" || !result.market) {
      continue;
    }
    const market = result.market;
    args.knownMarkets.set(market.slug, market);
    try {
      await upsertMarket(args.db, market);
    } catch (error) {
      args.log.warn("market upsert failed", {
        slug: market.slug,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  pruneOldMarkets(args.knownMarkets);
  args.ws.updateSubscriptions(collectAssetIds(args.knownMarkets));
}

function pruneOldMarkets(known: Map<string, ParsedMarket>): void {
  const cutoff = Date.now() - 6 * 60 * 1000;
  for (const [slug, market] of known) {
    if (market.endMs < cutoff) {
      known.delete(slug);
    }
  }
}

function collectAssetIds(known: Map<string, ParsedMarket>): readonly string[] {
  const ids: string[] = [];
  for (const market of known.values()) {
    if (market.upTokenId) {
      ids.push(market.upTokenId);
    }
    if (market.downTokenId) {
      ids.push(market.downTokenId);
    }
  }
  return ids;
}

function buildSubscriptions(
  knownMarkets: Map<string, ParsedMarket>,
): readonly SubscriptionView[] {
  const views: SubscriptionView[] = [];
  for (const market of knownMarkets.values()) {
    const keys: SubscriptionKey[] = [];
    if (market.upTokenId) {
      keys.push({
        marketSlug: market.slug,
        conditionId: market.conditionId,
        outcome: "Up",
        assetId: market.upTokenId,
      });
    }
    if (market.downTokenId) {
      keys.push({
        marketSlug: market.slug,
        conditionId: market.conditionId,
        outcome: "Down",
        assetId: market.downTokenId,
      });
    }
    if (keys.length > 0) {
      views.push({ endMs: market.endMs, keys });
    }
  }
  return views;
}

function startHeartbeatLoop(args: {
  db: DatabaseClient;
  runId: string;
  ws: PolymarketWsClient;
  registry: BookRegistry;
  options: CoordinatorOptions;
}): () => void {
  let stopped = false;
  const tick = async (): Promise<void> => {
    while (!stopped && !args.options.signal.aborted) {
      try {
        await writeHeartbeat(args.db, {
          runId: args.runId,
          component: "polymarket_ws",
          status: args.ws.status === "connected" ? "ok" : "degraded",
          detailsJson: {
            wsStatus: args.ws.status,
            subscriptions: args.ws.subscribedAssetIds.length,
            booksTracked: args.registry.size(),
            lastEventAtMs: args.ws.lastEventAtMs,
          },
        });
      } catch (error) {
        // never let heartbeat failures kill the collector
        logger.warn("heartbeat write failed", {
          component: "polymarket_ws",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        await sleep(HEARTBEAT_INTERVAL_MS, args.options.signal);
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
