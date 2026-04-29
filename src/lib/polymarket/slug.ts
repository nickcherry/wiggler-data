import { UPDOWN_5M_SLUG_INFIX } from "@wiggler/constants/markets";
import {
  assertWellFormedFiveMinuteWindow,
  type MarketWindow,
} from "@wiggler/lib/domain/marketWindow";

/**
 * Returns the canonical Polymarket slug prefix for a given asset's Up/Down
 * 5-minute markets. e.g. `BTC` -> `btc-updown-5m`.
 */
export function getUpDownSlugPrefix(assetSymbol: string): string {
  return `${assetSymbol.toLowerCase()}-${UPDOWN_5M_SLUG_INFIX}`;
}

/**
 * Builds the canonical Polymarket slug for an Up/Down 5-minute market that
 * starts at the given UTC unix timestamp (seconds).
 */
export function buildUpDownSlug(
  assetSymbol: string,
  startUnixSeconds: number,
): string {
  if (!Number.isInteger(startUnixSeconds) || startUnixSeconds <= 0) {
    throw new Error(`Invalid start unix seconds: ${startUnixSeconds}`);
  }
  return `${getUpDownSlugPrefix(assetSymbol)}-${startUnixSeconds}`;
}

/**
 * Builds the slug from a 5-minute window object.
 */
export function buildUpDownSlugFromWindow(
  assetSymbol: string,
  window: MarketWindow,
): string {
  assertWellFormedFiveMinuteWindow(window);
  return buildUpDownSlug(assetSymbol, Math.floor(window.startMs / 1000));
}

/**
 * Returns true if the slug looks like an Up/Down 5m slug for the given asset.
 */
export function isUpDownSlug(assetSymbol: string, slug: string): boolean {
  return slug.startsWith(`${getUpDownSlugPrefix(assetSymbol)}-`);
}

/**
 * Extracts the start unix seconds from a slug; returns null if the slug does
 * not match the expected `<asset>-updown-5m-<seconds>` shape.
 */
export function parseUpDownSlugStartSeconds(
  assetSymbol: string,
  slug: string,
): number | null {
  if (!isUpDownSlug(assetSymbol, slug)) {
    return null;
  }
  const tail = slug.slice(getUpDownSlugPrefix(assetSymbol).length + 1);
  const value = Number(tail);
  return Number.isInteger(value) && value > 0 ? value : null;
}
