import type { DatabaseClient } from "@wiggler/lib/db/types";
import type { MarketsTable } from "@wiggler/lib/db/types";
import type { Selectable } from "kysely";

export type MarketRow = Selectable<MarketsTable>;

/**
 * Loads a single market by slug.
 */
export async function getMarketBySlug(
  db: DatabaseClient,
  slug: string,
): Promise<MarketRow | null> {
  const row = await db
    .selectFrom("markets")
    .selectAll()
    .where("slug", "=", slug)
    .executeTakeFirst();
  return row ?? null;
}

/**
 * Loads markets whose start_ts is within the given absolute window.
 */
export async function listMarketsByWindow(
  db: DatabaseClient,
  args: Readonly<{
    assetSymbol: string;
    fromMs: number;
    toMs: number;
  }>,
): Promise<readonly MarketRow[]> {
  return await db
    .selectFrom("markets")
    .selectAll()
    .where("asset_symbol", "=", args.assetSymbol)
    .where("start_ts", ">=", new Date(args.fromMs))
    .where("start_ts", "<", new Date(args.toMs))
    .orderBy("start_ts", "asc")
    .execute();
}

/**
 * Returns the market whose window covers `referenceMs` (start inclusive, end exclusive).
 */
export async function getCurrentMarket(
  db: DatabaseClient,
  args: Readonly<{ assetSymbol: string; referenceMs: number }>,
): Promise<MarketRow | null> {
  const row = await db
    .selectFrom("markets")
    .selectAll()
    .where("asset_symbol", "=", args.assetSymbol)
    .where("start_ts", "<=", new Date(args.referenceMs))
    .where("end_ts", ">", new Date(args.referenceMs))
    .orderBy("start_ts", "desc")
    .limit(1)
    .executeTakeFirst();
  return row ?? null;
}
