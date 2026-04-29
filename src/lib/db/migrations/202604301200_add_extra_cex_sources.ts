import type { Database } from "@wiggler/lib/db/types";
import type { Kysely } from "kysely";

const ADDED_SOURCES = ["gemini", "bybit", "bitstamp", "bitfinex", "kraken"] as const;

/**
 * Adds five new CEX sources to `asset_price_snapshots`: gemini, bybit,
 * bitstamp, bitfinex, kraken. Each source contributes the same four columns
 * already in use for coinbase and binance: `<src>_mid_e8`, `<src>_bid_e8`,
 * `<src>_ask_e8`, `<src>_age_ms`. All nullable bigint — a source contributes
 * nulls when no tick has been seen since the collector started.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  for (const src of ADDED_SOURCES) {
    await db.schema
      .alterTable("asset_price_snapshots")
      .addColumn(`${src}_mid_e8`, "bigint")
      .addColumn(`${src}_bid_e8`, "bigint")
      .addColumn(`${src}_ask_e8`, "bigint")
      .addColumn(`${src}_age_ms`, "bigint")
      .execute();
  }
}

export async function down(db: Kysely<Database>): Promise<void> {
  for (const src of ADDED_SOURCES) {
    await db.schema
      .alterTable("asset_price_snapshots")
      .dropColumn(`${src}_mid_e8`)
      .dropColumn(`${src}_bid_e8`)
      .dropColumn(`${src}_ask_e8`)
      .dropColumn(`${src}_age_ms`)
      .execute();
  }
}
