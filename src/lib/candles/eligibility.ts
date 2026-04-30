/**
 * Asset eligibility policy for the v1 wiggler-prob-grid bundle.
 *
 * The decision is INTENTIONALLY hard-coded per asset rather than
 * derived from the diagnostics output: we want a human-reviewed call
 * about which assets are safe enough to feed wiggler, not a heuristic
 * that could silently flip an asset live based on a numeric threshold.
 *
 * v1 policy:
 *
 *   BTC, ETH, SOL, XRP, DOGE  → paper-eligible
 *   HYPE, BNB                 → quarantined (anchor imbalance from
 *                               single-venue vwap during directional
 *                               regimes; live distribution differs from
 *                               training distribution)
 *   <every asset>             → live-ineligible (see global reasons)
 *
 * Everything in this file is config — no logic to compute eligibility.
 * Diagnostics live in the validation artifact next to the config so
 * humans can audit a quarantine decision without reading code.
 */

export type AssetEligibility = Readonly<{
  asset: string;
  quarantine: boolean;
  quarantine_reasons: readonly string[];
  eligible_for_research: boolean;
  eligible_for_paper: boolean;
  eligible_for_live: boolean;
}>;

const HYPE_QUARANTINE_REASONS = [
  "Sustained Up-share imbalance: 83-89% across 7+ months in 2025-06 → 2025-12.",
  "vwap proxy was single-venue (Binance only) for the first ~6 months — coincides with HYPE's strongly directional post-launch regime.",
  "Up-share normalizes to ~50% only after Bitstamp + Coinbase joined the vwap (Feb 2026 onward).",
  "Training distribution is not stationary; the live distribution is unlikely to look like the 2025-06–2025-12 regime.",
] as const;

const BNB_QUARANTINE_REASONS = [
  "Sustained Up-share imbalance: 65-85% across 6 months in 2025-04 → 2025-09 (Binance-only vwap during a directional regime).",
  "Up-share normalizes to ~50% from 2025-11 onward, after Coinbase + Bitstamp join the vwap.",
  "Training distribution is not stationary; the early-period contamination biases bucket-level win rates the model would inherit.",
] as const;

const ASSET_POLICY: Readonly<Record<string, AssetEligibility>> = {
  BTC: {
    asset: "BTC",
    quarantine: false,
    quarantine_reasons: [],
    eligible_for_research: true,
    eligible_for_paper: true,
    eligible_for_live: false,
  },
  ETH: {
    asset: "ETH",
    quarantine: false,
    quarantine_reasons: [],
    eligible_for_research: true,
    eligible_for_paper: true,
    eligible_for_live: false,
  },
  SOL: {
    asset: "SOL",
    quarantine: false,
    quarantine_reasons: [],
    eligible_for_research: true,
    eligible_for_paper: true,
    eligible_for_live: false,
  },
  XRP: {
    asset: "XRP",
    quarantine: false,
    quarantine_reasons: [],
    eligible_for_research: true,
    eligible_for_paper: true,
    eligible_for_live: false,
  },
  DOGE: {
    asset: "DOGE",
    quarantine: false,
    quarantine_reasons: [],
    eligible_for_research: true,
    eligible_for_paper: true,
    eligible_for_live: false,
  },
  HYPE: {
    asset: "HYPE",
    quarantine: true,
    quarantine_reasons: HYPE_QUARANTINE_REASONS,
    eligible_for_research: true,
    eligible_for_paper: false,
    eligible_for_live: false,
  },
  BNB: {
    asset: "BNB",
    quarantine: true,
    quarantine_reasons: BNB_QUARANTINE_REASONS,
    eligible_for_research: true,
    eligible_for_paper: false,
    eligible_for_live: false,
  },
};

export const BUNDLE_ASSETS: readonly string[] = [
  "BTC",
  "ETH",
  "SOL",
  "XRP",
  "DOGE",
  "HYPE",
  "BNB",
] as const;

/**
 * Assets covered by the v1 policy. Anything outside this set has no
 * eligibility decision and the bundle command refuses to emit a
 * config for it.
 */
export function getEligibility(asset: string): AssetEligibility | null {
  return ASSET_POLICY[asset.toUpperCase()] ?? null;
}

/**
 * Why no asset is yet live-eligible. Surfaced verbatim in the bundle
 * manifest so wiggler-prod sees the gate the data side hasn't cleared.
 */
export const LIVE_INELIGIBILITY_REASONS: readonly string[] = [
  "Live Chainlink integration not tested. The training proxy (cross-source vwap) is not the resolution feed; basis risk vs Chainlink at the moment of resolution is unmeasured.",
  "Live Polymarket order-book ingestion not tested. No realistic execution-quality estimate exists.",
  "Only a single 9/3-month walk-forward holdout has been validated. Multi-window walk-forward calibration (e.g. monthly rolling) has not been run.",
  "1-minute candle granularity does not model the 0–59s remaining decision window — exactly where Polymarket short-window markets are most decisive. Sub-minute Chainlink/proxy data has not been ingested.",
  "Block-bootstrap p_lower (correlation-aware confidence interval) not yet implemented; current p_lower assumes i.i.d. rows, which is violated for the four decision rows per market.",
] as const;
