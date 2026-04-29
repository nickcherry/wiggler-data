import type { DatabaseClient } from "@wiggler/lib/db/types";
import type { ParsedMarket } from "@wiggler/lib/polymarket/types";
import { sql } from "kysely";

/**
 * Upserts a parsed Gamma market into the `markets` table. Refreshes
 * `last_seen_at`, `updated_at`, and the latest raw Gamma payload.
 */
export async function upsertMarket(
  db: DatabaseClient,
  parsed: ParsedMarket,
): Promise<void> {
  await db
    .insertInto("markets")
    .values({
      asset_symbol: parsed.assetSymbol,
      slug: parsed.slug,
      event_id: parsed.eventId,
      market_id: parsed.marketId,
      condition_id: parsed.conditionId,
      question: parsed.question,
      title: parsed.title,
      start_ts: new Date(parsed.startMs),
      end_ts: new Date(parsed.endMs),
      up_token_id: parsed.upTokenId,
      down_token_id: parsed.downTokenId,
      resolution_source: parsed.resolutionSource,
      active: parsed.active,
      closed: parsed.closed,
      archived: parsed.archived,
      resolved: parsed.resolved,
      resolved_outcome: parsed.resolvedOutcome,
      raw_gamma: parsed.rawGamma as never,
    })
    .onConflict((oc) =>
      oc.column("slug").doUpdateSet({
        asset_symbol: parsed.assetSymbol,
        event_id: parsed.eventId,
        market_id: parsed.marketId,
        condition_id: parsed.conditionId,
        question: parsed.question,
        title: parsed.title,
        start_ts: new Date(parsed.startMs),
        end_ts: new Date(parsed.endMs),
        up_token_id: parsed.upTokenId,
        down_token_id: parsed.downTokenId,
        resolution_source: parsed.resolutionSource,
        active: parsed.active,
        closed: parsed.closed,
        archived: parsed.archived,
        resolved: parsed.resolved,
        resolved_outcome: parsed.resolvedOutcome,
        raw_gamma: parsed.rawGamma as never,
        last_seen_at: sql`now()`,
        updated_at: sql`now()`,
      }),
    )
    .execute();
}
