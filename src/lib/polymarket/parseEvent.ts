import { FIVE_MINUTE_MS } from "@wiggler/constants/markets";
import { parseUpDownSlugStartSeconds } from "@wiggler/lib/polymarket/slug";
import {
  type GammaEvent,
  type GammaMarket,
  type GammaToken,
  type ParsedMarket,
} from "@wiggler/lib/polymarket/types";

const UP_OUTCOMES = new Set(["Up", "UP", "up", "Yes", "YES", "yes", "Higher", "higher"]);
const DOWN_OUTCOMES = new Set([
  "Down",
  "DOWN",
  "down",
  "No",
  "NO",
  "no",
  "Lower",
  "lower",
]);

type Tokens = Readonly<{
  upTokenId: string | null;
  downTokenId: string | null;
}>;

/**
 * Parses a Gamma event payload into the application's normalized market shape.
 * Designed to be defensive: missing fields become null but the raw event is
 * always preserved so audit tooling can flag the parse error.
 */
export function parseGammaEvent({
  event,
  raw,
  assetSymbol,
}: Readonly<{
  event: GammaEvent;
  raw: unknown;
  assetSymbol: string;
}>): ParsedMarket | null {
  const market = pickPrimaryMarket(event);
  const slug = event.slug ?? market?.slug ?? null;
  if (!slug) {
    return null;
  }

  // Up/Down 5m markets put the canonical window-start unix seconds in the
  // slug suffix. Gamma's event/market `startDate` fields are *creation*
  // timestamps (often a day before the actual window) so we cannot trust
  // them for the trading window. Prefer slug-derived start when the slug
  // matches the standard pattern; fall back to Gamma fields otherwise.
  const slugStartSeconds = parseUpDownSlugStartSeconds(assetSymbol, slug);
  const slugStartMs = slugStartSeconds !== null ? slugStartSeconds * 1000 : null;

  const fallbackStartMs = parseDateMs(
    event.startDate ?? market?.startDate ?? market?.startDateIso ?? market?.start_time ?? null,
  );
  const fallbackEndMs = parseDateMs(
    event.endDate ?? market?.endDate ?? market?.endDateIso ?? market?.end_time ?? null,
  );

  const startMs = slugStartMs ?? fallbackStartMs;
  const endMs =
    slugStartMs !== null ? slugStartMs + FIVE_MINUTE_MS : fallbackEndMs;
  if (startMs === null || endMs === null) {
    return null;
  }

  const tokens = extractTokens(market);
  const resolvedOutcome = extractResolvedOutcome(market);

  return {
    assetSymbol,
    slug,
    eventId: event.id !== undefined ? String(event.id) : null,
    marketId: market?.id !== undefined ? String(market.id) : null,
    conditionId: market?.conditionId ?? market?.condition_id ?? null,
    question: market?.question ?? null,
    title: event.title ?? null,
    startMs,
    endMs,
    upTokenId: tokens.upTokenId,
    downTokenId: tokens.downTokenId,
    resolutionSource: market?.resolutionSource ?? market?.resolution_source ?? null,
    active: event.active ?? market?.active ?? null,
    closed: event.closed ?? market?.closed ?? null,
    archived: event.archived ?? market?.archived ?? null,
    // For these automated Chainlink-settled markets, "resolved" is whatever
    // `extractResolvedOutcome` was able to derive — see that helper for why
    // the top-level Gamma `resolved: true` flag isn't trustworthy.
    resolved: resolvedOutcome !== null,
    resolvedOutcome,
    rawGamma: raw,
  };
}

function pickPrimaryMarket(event: GammaEvent): GammaMarket | undefined {
  const markets = event.markets ?? [];
  return markets[0];
}

function parseDateMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function extractTokens(market: GammaMarket | undefined): Tokens {
  if (!market) {
    return { upTokenId: null, downTokenId: null };
  }

  if (market.tokens && market.tokens.length > 0) {
    return tokensFromArray(market.tokens, market.outcomes);
  }

  const ids = parseStringArray(market.clobTokenIds);
  const outcomes = parseStringArray(market.outcomes);
  if (ids && ids.length === 2) {
    return alignTokenIdsToOutcomes(ids, outcomes);
  }

  return { upTokenId: null, downTokenId: null };
}

function tokensFromArray(
  tokens: readonly GammaToken[],
  outcomesField: GammaMarket["outcomes"],
): Tokens {
  const outcomesArr = parseStringArray(outcomesField);
  let upTokenId: string | null = null;
  let downTokenId: string | null = null;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) {
      continue;
    }
    const outcomeLabel = token.outcome ?? outcomesArr?.[i] ?? null;
    if (!token.token_id || !outcomeLabel) {
      continue;
    }
    if (UP_OUTCOMES.has(outcomeLabel)) {
      upTokenId = token.token_id;
    } else if (DOWN_OUTCOMES.has(outcomeLabel)) {
      downTokenId = token.token_id;
    }
  }

  return { upTokenId, downTokenId };
}

function alignTokenIdsToOutcomes(
  ids: readonly string[],
  outcomes: readonly string[] | null,
): Tokens {
  if (!outcomes || outcomes.length !== ids.length) {
    return { upTokenId: ids[0] ?? null, downTokenId: ids[1] ?? null };
  }
  let upTokenId: string | null = null;
  let downTokenId: string | null = null;
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    const outcome = outcomes[i];
    if (!id || !outcome) {
      continue;
    }
    if (UP_OUTCOMES.has(outcome)) {
      upTokenId = id;
    } else if (DOWN_OUTCOMES.has(outcome)) {
      downTokenId = id;
    }
  }
  if (upTokenId === null && downTokenId === null) {
    return { upTokenId: ids[0] ?? null, downTokenId: ids[1] ?? null };
  }
  return { upTokenId, downTokenId };
}

function parseStringArray(
  value: string | readonly string[] | undefined,
): readonly string[] | null {
  if (!value) {
    return null;
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => String(entry));
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Returns the winning outcome label for a closed Up/Down market, or null
 * when settlement hasn't completed yet.
 *
 * Polymarket's BTC Up/Down 5m markets settle automatically via Chainlink
 * Data Streams. The signal that settlement has happened is `closed: true`
 * combined with `outcomePrices` carrying a `"1"` against one of the
 * outcomes. The top-level event `resolved: true` flag is only set later
 * by UMA / manual review and arrives many minutes-to-hours after `closed`,
 * so we deliberately ignore it for these markets and key off `closed`
 * alone. Verified against live Gamma payloads where `closed: true`,
 * `closedTime` set, `outcomePrices: ["0","1"]`, and yet `resolved: false`.
 */
function extractResolvedOutcome(market: GammaMarket | undefined): string | null {
  if (!market) {
    return null;
  }
  if (market.closed !== true) {
    return null;
  }
  const prices = parseStringArray(market.outcomePrices);
  const outcomes = parseStringArray(market.outcomes);
  if (!prices || !outcomes || prices.length !== outcomes.length) {
    return null;
  }
  for (let i = 0; i < prices.length; i += 1) {
    if (Number(prices[i]) === 1) {
      return outcomes[i] ?? null;
    }
  }
  return null;
}
