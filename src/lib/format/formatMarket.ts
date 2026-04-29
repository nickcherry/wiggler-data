import type { ParsedMarket } from "@wiggler/lib/polymarket/types";

/**
 * Formats a parsed market into a multi-line human-readable block.
 */
export function formatParsedMarketBlock(market: ParsedMarket): string {
  const lines = [
    `slug: ${market.slug}`,
    `asset: ${market.assetSymbol}`,
    `window: ${new Date(market.startMs).toISOString()} -> ${new Date(market.endMs).toISOString()}`,
    `event_id: ${market.eventId ?? "(none)"}`,
    `market_id: ${market.marketId ?? "(none)"}`,
    `condition_id: ${market.conditionId ?? "(none)"}`,
    `question: ${market.question ?? "(none)"}`,
    `title: ${market.title ?? "(none)"}`,
    `up_token_id: ${market.upTokenId ?? "(none)"}`,
    `down_token_id: ${market.downTokenId ?? "(none)"}`,
    `resolution_source: ${market.resolutionSource ?? "(none)"}`,
    `active: ${formatBool(market.active)}`,
    `closed: ${formatBool(market.closed)}`,
    `archived: ${formatBool(market.archived)}`,
    `resolved: ${market.resolved ? "yes" : "no"}`,
    `resolved_outcome: ${market.resolvedOutcome ?? "(none)"}`,
  ];
  return lines.join("\n");
}

function formatBool(value: boolean | null): string {
  if (value === null) {
    return "(unknown)";
  }
  return value ? "yes" : "no";
}
