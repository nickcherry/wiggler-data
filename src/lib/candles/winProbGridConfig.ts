import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

import type { AssetEligibility } from "@wiggler/lib/candles/eligibility";
import type { LookaheadSource } from "@wiggler/lib/candles/lookahead";
import type {
  ClosePoint,
  SideLeading,
  VolBin,
  VolBinThresholds,
  WinProbGrid,
} from "@wiggler/lib/candles/winProbGrid";

/**
 * The JSON config artifact wiggler-data ships to wiggler. The contract:
 * given (`abs_d_bps`, `remaining_sec`, `vol_bin`) at a Polymarket
 * decision moment, wiggler looks up `p_win_lower` in `grid` and
 * compares against the executable Polymarket all-in price.
 *
 * Every field is intentionally explicit — wiggler cannot guess defaults
 * from its own state. The config carries everything needed to evaluate
 * a trade decision, plus enough provenance to reproduce or audit it.
 *
 * Schema version is the literal string `"wiggler-prob-grid-v1"`. Bump
 * it (and write a new TS shape) on any breaking field change.
 */
export const WIGGLER_PROB_GRID_VERSION = "wiggler-prob-grid-v1" as const;

export type WigglerProbGridConfig = Readonly<{
  version: typeof WIGGLER_PROB_GRID_VERSION;

  // ---------- Identity ----------
  asset: string;
  market_type: "up_down";
  interval_sec: number;
  /** "rolling" (every minute is a candidate market start) or "boundary"
   *  (only multiples of interval_sec). */
  anchor_mode: "rolling" | "boundary";

  // ---------- Provenance ----------
  generated_at_iso: string;
  /** Current git HEAD when this config was generated, plus dirty bit. */
  git: Readonly<{ commit_sha: string | null; dirty: boolean }>;
  /** Source of training-time price data. NOT the live resolution feed. */
  training_input: Readonly<{
    /** Internal lookahead-source key — what column the data came from. */
    label_source: LookaheadSource;
    /** Public-facing kind. `vwap_chainlink_proxy` flags the cross-source
     *  vwap as a stand-in for the live Chainlink resolution feed.
     *  Wiggler-prod compares this against its expected source kind. */
    label_source_kind: "vwap_chainlink_proxy" | "single_venue_chainlink_proxy";
    label_source_note: string;
    rowcount: number;
    window_start_ms: number | null;
    window_end_ms: number | null;
    /** SHA-256 of the canonical (tsMs, closeE8) pairs that fed the
     *  grid. Two runs with byte-identical input data produce the same
     *  hash; any candle change flips it. */
    input_hash: string;
  }>;
  /** What live wiggler should treat as authoritative at runtime. */
  resolution_source: Readonly<{
    intended: Readonly<{ name: string; symbol: string }>;
    /** Set when training data is NOT the same source as resolution — i.e.,
     * always today, since we don't have historical Chainlink data. */
    proxy_basis_risk: "unmeasured";
  }>;
  /** SHA-256 of the canonical-JSON `grid` array. Lets wiggler detect
   *  config drift without diffing the whole file. */
  config_hash: string;

  /** Per-asset eligibility decision. Wiggler-prod must check
   *  `eligible_for_paper` / `eligible_for_live` before trading any
   *  market backed by this config. */
  eligibility: AssetEligibility;

  // ---------- Bucket definitions ----------
  abs_d_bps_boundaries: readonly number[];
  remaining_sec_buckets: readonly number[];
  vol_bins: Readonly<{
    method: "training_terciles_with_p90_tail";
    /** Decision-time RMS-of-1m-returns thresholds in bps. Apply at runtime
     *  to the same lookback window used in training. */
    thresholds_bps_per_sqrt_min: VolBinThresholds;
    vol_lookback_min: number;
  }>;

  // ---------- Risk + execution defaults ----------
  fee: Readonly<{
    formula: "fee = shares * fee_rate * price * (1 - price)";
    /** Polymarket crypto taker fee rate at config-generation time. Wiggler
     *  is free to override at runtime if the on-chain rate changes. */
    taker_fee_rate: number;
  }>;
  risk_defaults: Readonly<{
    /** Wiggler refuses to trade in tighter remaining-sec windows than
     *  this. v1 sets this to 60 because we have no sub-minute training
     *  data — the 60s bucket should NOT be interpolated into 0–59s. */
    min_remaining_sec_to_trade: number;
    /** Edge threshold: trade only if `p_win_lower - all_in_cost ≥ this`. */
    min_edge_probability: number;
    /** Refuse to trade out of any bucket smaller than this. */
    min_bucket_count: number;
    max_position_usdc: number;
    kelly_fraction: number;
  }>;

  // ---------- Aggregate counts (sanity checks) ----------
  totals: Readonly<{
    decision_state_rows: number;
    up_win_anchors: number;
    down_win_anchors: number;
  }>;

  // ---------- The grid itself ----------
  grid: ReadonlyArray<
    Readonly<{
      remaining_sec: number;
      vol_bin: VolBin;
      side_leading: SideLeading;
      abs_d_bps_min: number;
      abs_d_bps_max: number | null;
      count: number;
      wins: number;
      p_win: number;
      p_win_lower: number;
      /** True iff `count >= risk_defaults.min_bucket_count`. Wiggler
       *  must refuse to trade any cell where this is false. */
      tradable: boolean;
    }>
  >;
}>;

/**
 * Defaults bundled into every emitted config. Overridable at the CLI;
 * wiggler is also free to override at runtime.
 */
export type RiskAndFeeDefaults = Readonly<{
  taker_fee_rate: number;
  min_remaining_sec_to_trade: number;
  min_edge_probability: number;
  min_bucket_count: number;
  max_position_usdc: number;
  kelly_fraction: number;
}>;

export const DEFAULT_RISK_AND_FEE: RiskAndFeeDefaults = {
  taker_fee_rate: 0.072,
  min_remaining_sec_to_trade: 60,
  min_edge_probability: 0.015,
  min_bucket_count: 500,
  max_position_usdc: 250,
  kelly_fraction: 0.1,
};

/**
 * Resolve current git HEAD info. Best-effort — returns nulls when we're
 * not in a git repo or git is unavailable. The dirty bit is true if the
 * working tree has uncommitted changes; production runs should ideally
 * be off a clean commit so the config is reproducible.
 */
export function readGitProvenance(): Readonly<{
  commit_sha: string | null;
  dirty: boolean;
}> {
  let commitSha: string | null = null;
  try {
    commitSha = execSync("git rev-parse HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return { commit_sha: null, dirty: false };
  }
  let dirty = false;
  try {
    const status = execSync("git status --porcelain", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    dirty = status.length > 0;
  } catch {
    // already have a commit, fall through
  }
  return { commit_sha: commitSha, dirty };
}

/**
 * SHA-256 of the canonical (tsMs, closeE8) pairs the model trained
 * on. Two runs that consumed byte-identical close prices produce the
 * same hash; any candle revision (open_time shift, late close
 * correction) flips it.
 */
export function computeInputHash(closes: readonly ClosePoint[]): string {
  const hash = createHash("sha256");
  for (const c of closes) {
    hash.update(c.tsMs.toString());
    hash.update("|");
    hash.update(c.closeE8.toString());
    hash.update("\n");
  }
  return hash.digest("hex");
}

/**
 * SHA-256 over the JSON-stringified buckets in declared order. Two
 * configs with the same model output produce identical hashes
 * regardless of incidental field reordering or whitespace.
 */
export function computeGridHash(grid: WinProbGrid): string {
  const canonical = grid.buckets.map((b) => ({
    remaining_sec: b.remainingSec,
    vol_bin: b.volBin,
    side_leading: b.sideLeading,
    abs_d_bps_min: b.absDBpsMin,
    abs_d_bps_max: b.absDBpsMax,
    count: b.count,
    wins: b.wins,
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Resolution-source metadata. v1 is hard-coded to Chainlink's BTC/USD
 * stream because that's what Polymarket's BTC up/down markets resolve
 * against. Other assets get a similar Chainlink stream — wire those in
 * here as we add them.
 */
const ASSET_RESOLUTION_SOURCE: Readonly<
  Record<string, { name: string; symbol: string }>
> = {
  BTC: { name: "Chainlink Data Streams", symbol: "BTC/USD" },
  ETH: { name: "Chainlink Data Streams", symbol: "ETH/USD" },
  SOL: { name: "Chainlink Data Streams", symbol: "SOL/USD" },
  XRP: { name: "Chainlink Data Streams", symbol: "XRP/USD" },
  HYPE: { name: "Chainlink Data Streams", symbol: "HYPE/USD" },
};

/**
 * Compose a `WigglerProbGridConfig` from a `WinProbGrid` plus the
 * surrounding context (asset, source, risk overrides). Pure: no I/O.
 */
export function buildWigglerProbGridConfig(args: {
  grid: WinProbGrid;
  asset: string;
  trainingLabelSource: LookaheadSource;
  volLookbackMin: number;
  /** SHA-256 of the closes used. Caller computes this so the config
   *  hash and input hash stay testable independent of the grid math. */
  inputHash: string;
  /** Eligibility for this asset (paper / live / quarantine). */
  eligibility: AssetEligibility;
  generatedAtIso?: string;
  git?: Readonly<{ commit_sha: string | null; dirty: boolean }>;
  riskDefaults?: Partial<RiskAndFeeDefaults>;
}): WigglerProbGridConfig {
  const merged = { ...DEFAULT_RISK_AND_FEE, ...args.riskDefaults };
  const intervalMin = args.grid.intervalSec / 60;
  const anchorMode: "rolling" | "boundary" =
    args.grid.anchorStepMin === intervalMin ? "boundary" : "rolling";
  const labelSourceKind:
    | "vwap_chainlink_proxy"
    | "single_venue_chainlink_proxy" =
    args.trainingLabelSource === "vwap"
      ? "vwap_chainlink_proxy"
      : "single_venue_chainlink_proxy";
  const labelSourceNote =
    args.trainingLabelSource === "vwap"
      ? "wiggler-data cross-source 1m VWAP across coinbase, binance, bitstamp. Used as a Chainlink proxy: at training time we have no historical Chainlink data, so basis risk versus the live resolution feed is unmeasured."
      : `wiggler-data raw 1m candles from ${args.trainingLabelSource}. Single-venue proxy for Chainlink — basis risk versus the live resolution feed is unmeasured.`;
  const resolutionMeta = ASSET_RESOLUTION_SOURCE[args.asset.toUpperCase()] ?? {
    name: "Chainlink Data Streams",
    symbol: `${args.asset.toUpperCase()}/USD`,
  };
  return {
    version: WIGGLER_PROB_GRID_VERSION,
    asset: args.asset.toUpperCase(),
    market_type: "up_down",
    interval_sec: args.grid.intervalSec,
    anchor_mode: anchorMode,
    generated_at_iso: args.generatedAtIso ?? new Date().toISOString(),
    git: args.git ?? readGitProvenance(),
    training_input: {
      label_source: args.trainingLabelSource,
      label_source_kind: labelSourceKind,
      label_source_note: labelSourceNote,
      rowcount: args.grid.totalRows,
      window_start_ms: args.grid.firstAnchorOpenTimeMs,
      window_end_ms: args.grid.lastIntervalEndOpenTimeMs,
      input_hash: args.inputHash,
    },
    resolution_source: {
      intended: resolutionMeta,
      proxy_basis_risk: "unmeasured",
    },
    config_hash: computeGridHash(args.grid),
    eligibility: args.eligibility,
    abs_d_bps_boundaries: args.grid.absDBpsBoundaries,
    remaining_sec_buckets: args.grid.decisionRemainingSecs,
    vol_bins: {
      method: "training_terciles_with_p90_tail",
      thresholds_bps_per_sqrt_min: args.grid.volBinThresholds,
      vol_lookback_min: args.volLookbackMin,
    },
    fee: {
      formula: "fee = shares * fee_rate * price * (1 - price)",
      taker_fee_rate: merged.taker_fee_rate,
    },
    risk_defaults: {
      min_remaining_sec_to_trade: merged.min_remaining_sec_to_trade,
      min_edge_probability: merged.min_edge_probability,
      min_bucket_count: merged.min_bucket_count,
      max_position_usdc: merged.max_position_usdc,
      kelly_fraction: merged.kelly_fraction,
    },
    totals: {
      decision_state_rows: args.grid.totalRows,
      up_win_anchors: args.grid.upWinAnchors,
      down_win_anchors: args.grid.downWinAnchors,
    },
    grid: args.grid.buckets.map((b) => ({
      remaining_sec: b.remainingSec,
      vol_bin: b.volBin,
      side_leading: b.sideLeading,
      abs_d_bps_min: b.absDBpsMin,
      abs_d_bps_max: b.absDBpsMax,
      count: b.count,
      wins: b.wins,
      p_win: round(b.pWin, 6),
      p_win_lower: round(b.pWinLower, 6),
      tradable: b.tradable,
    })),
  };
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
