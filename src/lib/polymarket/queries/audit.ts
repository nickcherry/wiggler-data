import type { DatabaseClient } from "@wiggler/lib/db/types";
import { sql } from "kysely";

/**
 * Aggregate count plus the most recent timestamp seen in a query window.
 * Used by the live `audit:latest` freshness checks.
 */
export type CountSinceResult = Readonly<{
  total: number;
  lastAt: Date | null;
}>;

/**
 * Counts every book snapshot captured since `sinceMs` and returns the most
 * recent `captured_at`. Asset-agnostic; the `audit:latest` thresholds use
 * this to detect a stalled snapshot scheduler. Doubles as the WS-liveness
 * proxy now that raw event rows aren't persisted — a stalled WS reader
 * stops producing fresh book frames, which stalls the scheduler's snapshot
 * stream within one cadence tick.
 */
export async function countSnapshotsSince(
  db: DatabaseClient,
  sinceMs: number,
): Promise<CountSinceResult> {
  const row = await db
    .selectFrom("book_snapshots")
    .select((eb) => [eb.fn.countAll<string>().as("total"), eb.fn.max("captured_at").as("last_at")])
    .where("captured_at", ">=", new Date(sinceMs))
    .executeTakeFirst();
  return parseCount(row);
}

/**
 * Counts every asset price snapshot captured since `sinceMs`. Used by
 * `audit:latest` to confirm the price scheduler is keeping up.
 */
export async function countPriceSnapshotsSince(
  db: DatabaseClient,
  args: Readonly<{ sinceMs: number; symbol: string }>,
): Promise<CountSinceResult> {
  const row = await db
    .selectFrom("asset_price_snapshots")
    .select((eb) => [eb.fn.countAll<string>().as("total"), eb.fn.max("captured_at").as("last_at")])
    .where("captured_at", ">=", new Date(args.sinceMs))
    .where("symbol", "=", args.symbol)
    .executeTakeFirst();
  return parseCount(row);
}

/**
 * One latest-snapshot row used by `audit:latest` to render best bid/ask per
 * outcome.
 */
export type LatestSnapshotRow = Readonly<{
  market_slug: string;
  asset_id: string;
  outcome: string;
  captured_at: Date;
  best_bid_e6: string | null;
  best_ask_e6: string | null;
  spread_e6: string | null;
}>;

/**
 * Returns the most recent snapshot row per `asset_id` for the given market.
 * Up/Down markets always have two outcomes, so the result is at most two rows.
 */
export async function listLatestSnapshotsForMarket(
  db: DatabaseClient,
  marketSlug: string,
): Promise<readonly LatestSnapshotRow[]> {
  const result = await sql<LatestSnapshotRow>`
    select distinct on (asset_id)
      market_slug,
      asset_id,
      outcome,
      captured_at,
      best_bid_e6,
      best_ask_e6,
      spread_e6
    from book_snapshots
    where market_slug = ${marketSlug}
    order by asset_id, captured_at desc
  `.execute(db);
  return result.rows;
}

/**
 * Aggregate counts and time bounds for a single market's snapshot coverage.
 */
export type MarketAuditCounts = Readonly<{
  snapshots: number;
  firstSnapshotAt: Date | null;
  lastSnapshotAt: Date | null;
}>;

/**
 * Returns book-snapshot coverage for a single market. In the snapshot-only
 * storage model this is the canonical "how much did we capture" query —
 * there is no separate raw-event count anymore.
 */
export async function getMarketAuditCounts(
  db: DatabaseClient,
  args: Readonly<{ marketSlug: string }>,
): Promise<MarketAuditCounts> {
  const row = await db
    .selectFrom("book_snapshots")
    .select((eb) => [
      eb.fn.countAll<string>().as("total"),
      eb.fn.min("captured_at").as("first_at"),
      eb.fn.max("captured_at").as("last_at"),
    ])
    .where("market_slug", "=", args.marketSlug)
    .executeTakeFirst();

  return {
    snapshots: row ? Number(row.total ?? 0) : 0,
    firstSnapshotAt: (row?.first_at as Date | null | undefined) ?? null,
    lastSnapshotAt: (row?.last_at as Date | null | undefined) ?? null,
  };
}

function parseCount(row: { total?: string; last_at?: Date | null } | undefined): CountSinceResult {
  return {
    total: row ? Number(row.total ?? 0) : 0,
    lastAt: row?.last_at ?? null,
  };
}
