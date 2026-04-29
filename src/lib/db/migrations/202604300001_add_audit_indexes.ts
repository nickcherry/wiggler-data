import type { Database } from "@wiggler/lib/db/types";
import type { Kysely } from "kysely";

/**
 * Adds two indexes that the live `audit:latest` query path needs:
 *
 *   1. `book_snapshots(captured_at)` — supports the global
 *      `count(*) where captured_at >= ?` freshness query in
 *      `countSnapshotsSince`. The existing composite indexes
 *      `(market_slug, captured_at)` and `(asset_id, captured_at)` lead with
 *      another column so they are useless here.
 *
 *   2. `book_snapshots(market_slug, asset_id, captured_at desc)` — supports
 *      the `select distinct on (asset_id) ... where market_slug = ? order by
 *      asset_id, captured_at desc` query in `listLatestSnapshotsForMarket`.
 *      With the descending order on `captured_at` baked into the index,
 *      Postgres can answer the whole distinct-on with a single index scan.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createIndex("book_snapshots_captured_at_idx")
    .on("book_snapshots")
    .columns(["captured_at"])
    .execute();

  await db.schema
    .createIndex("book_snapshots_market_asset_time_idx")
    .on("book_snapshots")
    .columns(["market_slug", "asset_id", "captured_at desc"])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropIndex("book_snapshots_market_asset_time_idx").ifExists().execute();
  await db.schema.dropIndex("book_snapshots_captured_at_idx").ifExists().execute();
}
