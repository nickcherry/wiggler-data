import type { StartAnchor } from "@wiggler/lib/analysis/types";
import type { DatabaseClient } from "@wiggler/lib/db/types";

/**
 * Returns the blended CEX midpoint for `(asset_symbol)` at the first
 * `asset_price_snapshots` row whose `captured_at` is at or after `startTs`.
 *
 * The snapshot scheduler ticks at `COLLECTOR_SNAPSHOT_INTERVAL_MS` (default
 * 1s), so the anchor's wall-clock drift from `startTs` is at most one
 * cadence tick. That's plenty fine for measuring percentage moves over a
 * 5-minute horizon. Returns `null` when the collector wasn't running yet
 * at the moment the market's window opened.
 */
export async function getStartAnchor(
  db: DatabaseClient,
  args: Readonly<{
    assetSymbol: string;
    startTs: Date;
  }>,
): Promise<StartAnchor | null> {
  const row = await db
    .selectFrom("asset_price_snapshots")
    .select(["captured_at", "blended_mid_e8"])
    .where("symbol", "=", args.assetSymbol)
    .where("captured_at", ">=", args.startTs)
    .where("blended_mid_e8", "is not", null)
    .orderBy("captured_at", "asc")
    .limit(1)
    .executeTakeFirst();
  if (!row || row.blended_mid_e8 === null) {
    return null;
  }
  return {
    blendedMidE8: BigInt(row.blended_mid_e8),
    anchorAt: row.captured_at,
  };
}
