import type { Candle } from "@wiggler/lib/candles/types";
import type { DatabaseClient } from "@wiggler/lib/db/types";
import { sql } from "kysely";

/**
 * Idempotently upserts a batch of candles. The PK is
 * `(source, symbol, timeframe, open_time)`, so re-running a sync over an
 * already-fetched window updates each row's OHLCV in place rather than
 * inserting duplicates. `fetched_at` is refreshed on every upsert so
 * `candles:status` can show the most recent sync time per series.
 *
 * Returns the number of rows upserted (the count includes both inserts
 * and updates — Postgres doesn't distinguish in `RETURNING`).
 */
export async function upsertCandles(
  db: DatabaseClient,
  candles: readonly Candle[],
): Promise<number> {
  if (candles.length === 0) {
    return 0;
  }
  const rows = candles.map((c) => ({
    source: c.source,
    symbol: c.symbol,
    exchange_pair: c.exchangePair,
    timeframe: c.timeframe,
    open_time: new Date(c.openTimeMs),
    open_time_ms: c.openTimeMs.toString(),
    open_e8: c.openE8.toString(),
    high_e8: c.highE8.toString(),
    low_e8: c.lowE8.toString(),
    close_e8: c.closeE8.toString(),
    volume_e8: c.volumeE8 !== null ? c.volumeE8.toString() : null,
    trades: c.tradeCount,
  }));
  await db
    .insertInto("candles")
    .values(rows)
    .onConflict((oc) =>
      oc.columns(["source", "symbol", "timeframe", "open_time"]).doUpdateSet({
        exchange_pair: (eb) => eb.ref("excluded.exchange_pair"),
        open_time_ms: (eb) => eb.ref("excluded.open_time_ms"),
        open_e8: (eb) => eb.ref("excluded.open_e8"),
        high_e8: (eb) => eb.ref("excluded.high_e8"),
        low_e8: (eb) => eb.ref("excluded.low_e8"),
        close_e8: (eb) => eb.ref("excluded.close_e8"),
        volume_e8: (eb) => eb.ref("excluded.volume_e8"),
        trades: (eb) => eb.ref("excluded.trades"),
        fetched_at: sql`now()`,
      }),
    )
    .execute();
  return rows.length;
}
