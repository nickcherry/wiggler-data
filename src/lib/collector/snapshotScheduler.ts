import type { DatabaseClient } from "@wiggler/lib/db/types";
import { logger } from "@wiggler/lib/logging/logger";
import type { BookRegistry } from "@wiggler/lib/polymarket/bookRegistry";
import { storeBookSnapshot } from "@wiggler/lib/polymarket/storeBookSnapshot";
import type { CexPriceRegistry } from "@wiggler/lib/prices/state";
import { storeAssetPriceSnapshot } from "@wiggler/lib/prices/storeAssetPriceSnapshot";
import { sleep } from "@wiggler/lib/util/sleep";

/** One outcome of a single market that we want to snapshot. */
export type SubscriptionKey = Readonly<{
  marketSlug: string;
  conditionId: string | null;
  outcome: "Up" | "Down";
  assetId: string;
}>;

/** A market's pair of subscription keys plus its window-end timestamp. */
export type SubscriptionView = Readonly<{
  endMs: number;
  keys: readonly SubscriptionKey[];
}>;

export type SnapshotSchedulerOptions = Readonly<{
  db: DatabaseClient;
  bookRegistry: BookRegistry;
  priceRegistry: CexPriceRegistry;
  /** Symbols whose CEX price state should be snapshotted each tick. */
  priceSymbols: readonly string[];
  depth: number;
  /** Uniform cadence; one tick produces one set of snapshots. */
  intervalMs: number;
  signal: AbortSignal;
  getSubscriptions: () => readonly SubscriptionView[];
  onTick?: (
    capturedAtMs: number,
    counts: { books: number; prices: number },
  ) => void;
}>;

/**
 * Single-cadence snapshot scheduler. Every `intervalMs` it captures:
 *
 *   1. one `book_snapshots` + N `book_levels` rows per active (market, outcome)
 *      whose book has received at least one snapshot
 *   2. one `asset_price_snapshots` row per configured symbol, holding the
 *      latest CEX state plus a blended midpoint
 *
 * All rows for one tick share an identical `captured_at_ms`, which is the
 * exact join key downstream analysis uses to align Polymarket book state
 * with the CEX BTC price at the same instant.
 */
export async function runSnapshotScheduler(
  options: SnapshotSchedulerOptions,
): Promise<void> {
  while (!options.signal.aborted) {
    const now = Date.now();
    const subs = options.getSubscriptions();
    const books = await captureBookSnapshots(options, subs, now);
    const prices = await captureAssetPriceSnapshots(options, now);
    options.onTick?.(now, { books, prices });
    try {
      await sleep(options.intervalMs, options.signal);
    } catch {
      return;
    }
  }
}

async function captureBookSnapshots(
  options: SnapshotSchedulerOptions,
  subs: readonly SubscriptionView[],
  nowMs: number,
): Promise<number> {
  let written = 0;
  for (const sub of subs) {
    for (const key of sub.keys) {
      const book = options.bookRegistry.get(key.assetId);
      if (!book || !book.hasSnapshot || book.isEmpty()) {
        continue;
      }
      try {
        await storeBookSnapshot(options.db, book, {
          marketSlug: key.marketSlug,
          conditionId: key.conditionId,
          outcome: key.outcome,
          depth: options.depth,
          capturedAtMs: nowMs,
        });
        written += 1;
      } catch (error) {
        logger.error("snapshot write failed", {
          component: "book_snapshotter",
          marketSlug: key.marketSlug,
          assetId: key.assetId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return written;
}

async function captureAssetPriceSnapshots(
  options: SnapshotSchedulerOptions,
  nowMs: number,
): Promise<number> {
  let written = 0;
  for (const symbol of options.priceSymbols) {
    try {
      await storeAssetPriceSnapshot(options.db, {
        registry: options.priceRegistry,
        symbol,
        capturedAtMs: nowMs,
      });
      written += 1;
    } catch (error) {
      logger.error("asset price snapshot write failed", {
        component: "price_snapshotter",
        symbol,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return written;
}
