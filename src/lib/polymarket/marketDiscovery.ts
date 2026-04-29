import {
  getFiveMinuteWindowSeries,
  type MarketWindow,
} from "@wiggler/lib/domain/marketWindow";
import { logger } from "@wiggler/lib/logging/logger";
import { fetchGammaEventBySlug } from "@wiggler/lib/polymarket/gammaClient";
import { parseGammaEvent } from "@wiggler/lib/polymarket/parseEvent";
import { buildUpDownSlugFromWindow } from "@wiggler/lib/polymarket/slug";
import type { ParsedMarket } from "@wiggler/lib/polymarket/types";

export type DiscoveryResult = Readonly<{
  window: MarketWindow;
  slug: string;
  status: "ok" | "not_found" | "error" | "parse_error";
  market: ParsedMarket | null;
  detail?: string;
}>;

/**
 * Discovers Up/Down 5-minute markets for the given asset across a sliding
 * window range. Each candidate slug is looked up via the Gamma
 * `/events/slug/{slug}` endpoint.
 */
export async function discoverUpDownMarkets({
  reference = new Date(),
  lookback,
  lookahead,
  assetSymbol,
  signal,
}: Readonly<{
  reference?: Date | number;
  lookback: number;
  lookahead: number;
  assetSymbol: string;
  signal?: AbortSignal;
}>): Promise<readonly DiscoveryResult[]> {
  const windows = getFiveMinuteWindowSeries({ reference, lookback, lookahead });
  const results: DiscoveryResult[] = [];

  for (const window of windows) {
    const slug = buildUpDownSlugFromWindow(assetSymbol, window);
    const fetched = await fetchGammaEventBySlug(slug, { signal });
    if (fetched.status === "not_found") {
      results.push({ window, slug, status: "not_found", market: null });
      continue;
    }
    if (fetched.status === "error") {
      logger.warn("gamma fetch error", {
        component: "market_discovery",
        slug,
        httpStatus: fetched.httpStatus,
      });
      results.push({
        window,
        slug,
        status: "error",
        market: null,
        detail: `http ${fetched.httpStatus}`,
      });
      continue;
    }

    const parsed = parseGammaEvent({
      event: fetched.event,
      raw: fetched.raw,
      assetSymbol,
    });
    if (!parsed) {
      results.push({
        window,
        slug,
        status: "parse_error",
        market: null,
        detail: "missing slug or window",
      });
      continue;
    }
    results.push({ window, slug, status: "ok", market: parsed });
  }

  return results;
}
