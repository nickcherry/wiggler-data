import type {
  StartAnchor,
  WindowTimeSeriesRow,
} from "@wiggler/lib/analysis/types";
import type { DatabaseClient } from "@wiggler/lib/db/types";
import { sql } from "kysely";

type RawRow = Readonly<{
  captured_at: Date;
  captured_at_ms: string;
  up_bid_e6: string | null;
  up_ask_e6: string | null;
  down_bid_e6: string | null;
  down_ask_e6: string | null;
  blended_mid_e8: string | null;
}>;

/**
 * Returns one row per snapshot tick for the given market, with Up and Down
 * top-of-book pivoted into a single row and the blended CEX midpoint joined
 * by `captured_at_ms`. Adds `pctMove` and `secondsSinceStart` /
 * `secondsLeft` derived from the supplied anchor and the market's window.
 *
 * The pivot uses `MAX(CASE outcome ...)` because each tick produces exactly
 * one row per outcome (Up + Down) and we want them merged. Anchor + window
 * arithmetic happens here rather than in SQL so callers can pass a synthetic
 * anchor for what-if analysis without re-running the start-anchor query.
 */
export async function getWindowTimeSeries(
  db: DatabaseClient,
  args: Readonly<{
    marketSlug: string;
    assetSymbol: string;
    startTs: Date;
    endTs: Date;
    anchor: StartAnchor | null;
  }>,
): Promise<readonly WindowTimeSeriesRow[]> {
  const result = await sql<RawRow>`
    select
      bs.captured_at,
      bs.captured_at_ms,
      max(case when bs.outcome = 'Up'   then bs.best_bid_e6 end) as up_bid_e6,
      max(case when bs.outcome = 'Up'   then bs.best_ask_e6 end) as up_ask_e6,
      max(case when bs.outcome = 'Down' then bs.best_bid_e6 end) as down_bid_e6,
      max(case when bs.outcome = 'Down' then bs.best_ask_e6 end) as down_ask_e6,
      ap.blended_mid_e8
    from book_snapshots bs
    left join asset_price_snapshots ap
      on ap.captured_at_ms = bs.captured_at_ms
     and ap.symbol = ${args.assetSymbol}
    where bs.market_slug = ${args.marketSlug}
    group by bs.captured_at, bs.captured_at_ms, ap.blended_mid_e8
    order by bs.captured_at_ms asc
  `.execute(db);

  const startMs = args.startTs.getTime();
  const endMs = args.endTs.getTime();
  const anchor = args.anchor;

  return result.rows.map((row): WindowTimeSeriesRow => {
    const capturedAtMs = Number(row.captured_at_ms);
    const blendedMidE8 = row.blended_mid_e8 ? BigInt(row.blended_mid_e8) : null;
    const pctMove =
      anchor && blendedMidE8 !== null && anchor.blendedMidE8 !== 0n
        ? Number(blendedMidE8 - anchor.blendedMidE8) / Number(anchor.blendedMidE8)
        : null;
    return {
      capturedAtMs,
      capturedAt: row.captured_at,
      secondsSinceStart: Math.floor((capturedAtMs - startMs) / 1000),
      secondsLeft: Math.max(0, Math.floor((endMs - capturedAtMs) / 1000)),
      blendedMidE8,
      pctMove,
      upBidE6: row.up_bid_e6 ? BigInt(row.up_bid_e6) : null,
      upAskE6: row.up_ask_e6 ? BigInt(row.up_ask_e6) : null,
      downBidE6: row.down_bid_e6 ? BigInt(row.down_bid_e6) : null,
      downAskE6: row.down_ask_e6 ? BigInt(row.down_ask_e6) : null,
    };
  });
}
