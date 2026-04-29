import type { DatabaseClient } from "@wiggler/lib/db/types";
import type { BookState } from "@wiggler/lib/polymarket/bookState";

export type SnapshotContext = Readonly<{
  marketSlug: string;
  conditionId: string | null;
  outcome: string;
  depth: number;
  capturedAtMs: number;
}>;

/**
 * Captures the current top-N book and writes one row to `book_snapshots` plus
 * one row per level into `book_levels`. Returns the inserted snapshot id.
 */
export async function storeBookSnapshot(
  db: DatabaseClient,
  book: BookState,
  context: SnapshotContext,
): Promise<bigint | null> {
  const top = book.getTopLevels(context.depth);
  const bestBid = top.bids[0] ?? null;
  const bestAsk = top.asks[0] ?? null;

  const snapshotIdRaw = await db
    .insertInto("book_snapshots")
    .values({
      captured_at: new Date(context.capturedAtMs),
      captured_at_ms: context.capturedAtMs.toString(),
      market_slug: context.marketSlug,
      condition_id: context.conditionId,
      asset_id: book.assetId,
      outcome: context.outcome,
      best_bid_e6: bestBid ? bestBid.priceE6.toString() : null,
      best_ask_e6: bestAsk ? bestAsk.priceE6.toString() : null,
      spread_e6:
        bestBid && bestAsk ? (bestAsk.priceE6 - bestBid.priceE6).toString() : null,
      tick_size_e6: book.tickSizeE6 ? book.tickSizeE6.toString() : null,
      book_hash: book.hashTopLevels(context.depth),
      depth_limit: context.depth,
      raw_source: "ws_reconstructed",
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  const snapshotId = BigInt(snapshotIdRaw.id);

  const rows: Array<{
    snapshot_id: string;
    side: "bid" | "ask";
    level_index: number;
    price_e6: string;
    size_e6: string;
  }> = [];
  top.bids.forEach((level, index) => {
    rows.push({
      snapshot_id: snapshotId.toString(),
      side: "bid",
      level_index: index,
      price_e6: level.priceE6.toString(),
      size_e6: level.sizeE6.toString(),
    });
  });
  top.asks.forEach((level, index) => {
    rows.push({
      snapshot_id: snapshotId.toString(),
      side: "ask",
      level_index: index,
      price_e6: level.priceE6.toString(),
      size_e6: level.sizeE6.toString(),
    });
  });
  if (rows.length > 0) {
    await db.insertInto("book_levels").values(rows).execute();
  }
  return snapshotId;
}
