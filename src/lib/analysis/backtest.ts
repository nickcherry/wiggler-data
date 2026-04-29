import type {
  BacktestResult,
  TriggerConfig,
} from "@wiggler/lib/analysis/types";
import type { DatabaseClient } from "@wiggler/lib/db/types";
import { sql } from "kysely";

/**
 * Walks every resolved market for the given asset and applies the trigger
 * predicate to every snapshot tick. Returns aggregate hit/miss/PnL stats
 * for the configuration.
 *
 * Predicate (per snapshot tick of an outcome's book):
 *
 *   - resolved market with non-null `resolved_outcome`
 *   - `seconds_left <= maxSecondsLeft`
 *   - `pct_move`, signed by `side`, is `>= minPctMove`
 *   - the outcome's `best_ask_e6 <= maxEntryPriceE6`
 *   - `sum(book_levels.size_e6)` for the ask side at prices `<= maxEntryPriceE6`
 *     is `>= minFillableSizeE6`
 *
 * "Hit" means `markets.resolved_outcome === config.side`. PnL per share
 * assumes you buy at `best_ask` and hold to expiration: a win pays
 * `1 - entry`, a loss pays `-entry`. Fees are NOT modeled here.
 *
 * The whole computation is one SQL query so Postgres can plan it; we never
 * loop over markets in TS. With current indexes the query is single-digit
 * seconds even on tens of thousands of resolved markets.
 */
export async function runBacktest(
  db: DatabaseClient,
  args: Readonly<{
    assetSymbol: string;
    config: TriggerConfig;
  }>,
): Promise<BacktestResult> {
  const { assetSymbol, config } = args;
  const sideSign = config.side === "Up" ? 1 : -1;

  type AggregateRow = Readonly<{
    resolved_markets: string;
    triggers: string;
    hits: string;
    misses: string;
    sum_pnl_e6: string | null;
  }>;

  const result = await sql<AggregateRow>`
    with anchor as (
      -- One row per resolved market: the start-anchor blended midpoint
      -- (first snapshot at or after the window's start_ts).
      select
        m.slug,
        m.start_ts,
        m.end_ts,
        m.resolved_outcome,
        (
          select ap.blended_mid_e8
          from asset_price_snapshots ap
          where ap.symbol = ${assetSymbol}
            and ap.captured_at >= m.start_ts
            and ap.blended_mid_e8 is not null
          order by ap.captured_at asc
          limit 1
        ) as start_blended_mid_e8
      from markets m
      where m.asset_symbol = ${assetSymbol}
        and m.resolved = true
        and m.resolved_outcome is not null
    ),
    triggers as (
      select
        bs.id as snapshot_id,
        a.slug,
        a.resolved_outcome,
        bs.captured_at_ms,
        bs.best_ask_e6,
        floor(extract(epoch from (a.end_ts - bs.captured_at))) as seconds_left,
        ap.blended_mid_e8,
        a.start_blended_mid_e8,
        (cast(ap.blended_mid_e8 as numeric) - cast(a.start_blended_mid_e8 as numeric))
          / cast(a.start_blended_mid_e8 as numeric) as pct_move
      from anchor a
      join book_snapshots bs on bs.market_slug = a.slug
      left join asset_price_snapshots ap
        on ap.captured_at_ms = bs.captured_at_ms
       and ap.symbol = ${assetSymbol}
      where a.start_blended_mid_e8 is not null
        and a.start_blended_mid_e8 > 0
        and bs.outcome = ${config.side}
        and bs.captured_at >= a.start_ts
        and bs.captured_at <= a.end_ts
        and bs.best_ask_e6 is not null
    ),
    candidates as (
      select t.*
      from triggers t
      where t.blended_mid_e8 is not null
        and t.seconds_left <= ${config.maxSecondsLeft}
        and t.best_ask_e6 <= ${config.maxEntryPriceE6.toString()}
        and (cast(${sideSign} as int) * t.pct_move) >= ${config.minPctMove}
    ),
    fillable as (
      select c.*,
        coalesce((
          select sum(bl.size_e6)
          from book_levels bl
          where bl.snapshot_id = c.snapshot_id
            and bl.side = 'ask'
            and bl.price_e6 <= ${config.maxEntryPriceE6.toString()}
        ), 0) as fillable_size_e6
      from candidates c
    ),
    matched as (
      select
        f.resolved_outcome,
        cast(f.best_ask_e6 as numeric) / 1000000.0 as entry_price,
        case when f.resolved_outcome = ${config.side}
             then 1.0 - cast(f.best_ask_e6 as numeric) / 1000000.0
             else      - cast(f.best_ask_e6 as numeric) / 1000000.0
        end as pnl_per_share
      from fillable f
      where f.fillable_size_e6 >= ${config.minFillableSizeE6.toString()}
    )
    select
      (select count(*) from anchor) as resolved_markets,
      (select count(*) from matched) as triggers,
      (select count(*) from matched where resolved_outcome = ${config.side}) as hits,
      (select count(*) from matched where resolved_outcome <> ${config.side}) as misses,
      (select sum(pnl_per_share) from matched) as sum_pnl_e6
  `.execute(db);

  const row = result.rows[0];
  if (!row) {
    return emptyResult(config);
  }

  const resolvedMarkets = Number(row.resolved_markets);
  const triggers = Number(row.triggers);
  const hits = Number(row.hits);
  const misses = Number(row.misses);
  const sumPnl = row.sum_pnl_e6 !== null ? Number(row.sum_pnl_e6) : 0;

  return {
    config,
    resolvedMarkets,
    triggers,
    hits,
    misses,
    hitRate: triggers > 0 ? hits / triggers : null,
    meanPnlPerShare: triggers > 0 ? sumPnl / triggers : null,
  };
}

function emptyResult(config: TriggerConfig): BacktestResult {
  return {
    config,
    resolvedMarkets: 0,
    triggers: 0,
    hits: 0,
    misses: 0,
    hitRate: null,
    meanPnlPerShare: null,
  };
}
