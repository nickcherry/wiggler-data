import { bpsChange } from "@wiggler/lib/candles/lookahead";
import { wilsonLowerBound } from "@wiggler/lib/candles/wilsonInterval";

/**
 * Calibrated win-probability grid for fixed-window up/down prediction
 * markets. Built from historical close-prices treated as a Chainlink
 * proxy.
 *
 * The deliverable is the JSON config consumed by wiggler at runtime:
 * given (`abs_d_bps`, `remaining_sec`, `vol_bin`) for the current side,
 * look up `p_win_lower` and trade only if it beats the executable
 * Polymarket all-in price + required edge.
 *
 * Why empirical / non-parametric: 1-minute crypto returns aren't
 * Gaussian (fat tails, vol clustering). A simple bucket-and-count
 * approach with a Wilson lower bound is robust to that, costs nothing
 * to evaluate, and is easy to audit cell-by-cell. Smarter models
 * (logistic / GBM) can come later — they'd be calibrated against this
 * grid as ground truth.
 *
 * # Candle-timestamp semantics — read this before touching the math
 *
 * Every candle source we ingest stores `open_time = T` to mean the bar
 * covers the half-open interval `[T, T + 60s)`, with `close_e8` being
 * the last trade inside that interval. That close is FIRST KNOWABLE
 * at wall-clock time `T + 60s` — never sooner.
 *
 * This module models a market that spans the 5-minute (or
 * `intervalMin`-minute) wall-clock interval whose start moment lines
 * up with the FIRST-KNOWABLE moment of the anchor candle. Concretely,
 * with `i` the index of the anchor candle in `closeAt` (so the anchor
 * candle's open_time is `baseMs + i*60s`):
 *
 *   - market start (T_start)   = baseMs + (i + 1)*60s
 *   - market end   (T_end)     = T_start + intervalSec
 *   - decision time (T_d)      = T_end - remainingSec
 *
 *   - line price (price at T_start)   ≈ closeAt[i]
 *     (knowable at T_start, not before)
 *   - final price (price at T_end)    ≈ closeAt[i + intervalMin]
 *     (knowable at T_end)
 *   - current price at T_d            ≈ closeAt[i + (intervalMin - remainingSec/60)]
 *     (knowable at T_d, not before)
 *
 * In particular, with intervalMin=5 and remainingSec=60, the current
 * price comes from `closeAt[i + 4]`, whose first-knowable moment is
 * `baseMs + (i+5)*60s` = `T_d` exactly. NOT `closeAt[i + 5]`, which is
 * the resolution price and only becomes knowable at `T_end`.
 *
 * If you change the offsets in `buildWinProbGrid`, audit this section.
 */

/**
 * Default boundaries (in absolute basis points) for binning the
 * current lead. Tighter grain near zero where most decisions live;
 * wider buckets out in the tail where they get rare. The last bucket
 * is open-ended — anything above 75 bps gets pooled.
 *
 * `[a, b]` here means `[a, b)`. The final bucket has `b = null`.
 */
export const DEFAULT_ABS_D_BPS_BOUNDARIES: readonly number[] = [
  0, 2, 4, 6, 8, 10, 15, 20, 25, 30, 40, 50, 75,
] as const;

export type VolBin = "low" | "normal" | "high" | "extreme";
export const VOL_BINS: readonly VolBin[] = [
  "low",
  "normal",
  "high",
  "extreme",
] as const;

/**
 * Decision-time volatility bin assignment. Boundaries are derived per
 * training run from the empirical distribution of `recent_vol` values
 * across all decision points. Wiggler uses the same thresholds at
 * runtime to bin the live recent-vol estimate.
 *
 *   low      ≤ p33
 *   p33    < normal   ≤ p67
 *   p67    < high     ≤ p90
 *   extreme > p90
 *
 * The 33/67/90 split puts more granularity at the high tail (where
 * direction is least sticky) while keeping `normal` fat enough to be
 * useful as the modal regime.
 */
export type VolBinThresholds = Readonly<{
  lowMaxBpsPerSqrtMin: number;
  normalMaxBpsPerSqrtMin: number;
  highMaxBpsPerSqrtMin: number;
}>;

export const VOL_BIN_TRAINING_PERCENTILES = {
  lowMax: 0.33,
  normalMax: 0.67,
  highMax: 0.9,
} as const;

/** One close-price observation. */
export type ClosePoint = Readonly<{ tsMs: number; closeE8: bigint }>;

/** One bucket in the output grid. */
export type WinProbBucket = Readonly<{
  remainingSec: number;
  volBin: VolBin;
  absDBpsMin: number;
  /** `null` means open-ended (top tail). */
  absDBpsMax: number | null;
  count: number;
  wins: number;
  pWin: number;
  pWinLower: number;
}>;

export type WinProbGrid = Readonly<{
  intervalSec: number;
  /** Anchor stride in minutes. 1 = rolling, intervalMin = boundary-aligned. */
  anchorStepMin: number;
  decisionRemainingSecs: readonly number[];
  absDBpsBoundaries: readonly number[];
  volBinThresholds: VolBinThresholds;
  /** Number of decision states scanned (sum of `count` across buckets). */
  totalRows: number;
  /** Anchors whose interval finished above-or-equal the start price (Up). */
  upWinAnchors: number;
  /** Anchors whose interval finished strictly below the start price (Down). */
  downWinAnchors: number;
  /** First anchor candle open_time (ms). Defines training window start. */
  firstAnchorOpenTimeMs: number | null;
  /** Last interval-end open_time used (ms). Defines training window end. */
  lastIntervalEndOpenTimeMs: number | null;
  buckets: readonly WinProbBucket[];
}>;

/**
 * Map an absolute distance (bps) to its bucket index in
 * `boundaries`. The bucket corresponding to index `i` covers
 * `[boundaries[i], boundaries[i+1])`. The last bucket is open-ended.
 *
 * Boundaries must be strictly ascending and start at 0.
 */
export function bucketAbsDBps(
  absDBps: number,
  boundaries: readonly number[],
): number {
  if (absDBps < 0 || !Number.isFinite(absDBps)) {
    throw new Error(`absDBps must be a non-negative finite number, got ${absDBps}`);
  }
  // Tail bucket
  if (absDBps >= boundaries[boundaries.length - 1]!) {
    return boundaries.length - 1;
  }
  // Linear scan — boundaries is short (~13 entries).
  for (let i = boundaries.length - 1; i >= 0; i--) {
    if (absDBps >= boundaries[i]!) {
      return i;
    }
  }
  // absDBps is non-negative and boundaries[0]=0, so we should never
  // get here. Defensive fallback returns the first bucket.
  return 0;
}

/**
 * Returns `[min, max]` for bucket index `i`, with `max=null` for the
 * open-ended tail bucket.
 */
export function bucketRange(
  i: number,
  boundaries: readonly number[],
): Readonly<{ min: number; max: number | null }> {
  return {
    min: boundaries[i]!,
    max: i + 1 < boundaries.length ? boundaries[i + 1]! : null,
  };
}

/**
 * Bin a `recent_vol_per_sqrt_min` value into one of the four named
 * volatility regimes using the per-training-run thresholds.
 */
export function binVol(value: number, t: VolBinThresholds): VolBin {
  if (value <= t.lowMaxBpsPerSqrtMin) {return "low";}
  if (value <= t.normalMaxBpsPerSqrtMin) {return "normal";}
  if (value <= t.highMaxBpsPerSqrtMin) {return "high";}
  return "extreme";
}

/**
 * Selects an exact percentile by linear interpolation from a sorted
 * ascending array. Throws on empty input.
 */
export function percentile(
  sortedAsc: readonly number[],
  q: number,
): number {
  if (sortedAsc.length === 0) {
    throw new Error("percentile of empty array is undefined");
  }
  if (q < 0 || q > 1) {
    throw new Error(`q must be in [0,1], got ${q}`);
  }
  if (sortedAsc.length === 1) {
    return sortedAsc[0]!;
  }
  const pos = q * (sortedAsc.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) {
    return sortedAsc[lo]!;
  }
  const frac = pos - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

/**
 * Computes vol-bin thresholds from a population of recent-vol values.
 * Uses the static 33/67/90 percentile split documented on
 * `VOL_BIN_TRAINING_PERCENTILES`.
 */
export function deriveVolBinThresholds(
  recentVolValues: readonly number[],
): VolBinThresholds {
  if (recentVolValues.length === 0) {
    throw new Error("cannot derive vol-bin thresholds from empty input");
  }
  const sorted = [...recentVolValues].sort((a, b) => a - b);
  return {
    lowMaxBpsPerSqrtMin: percentile(sorted, VOL_BIN_TRAINING_PERCENTILES.lowMax),
    normalMaxBpsPerSqrtMin: percentile(
      sorted,
      VOL_BIN_TRAINING_PERCENTILES.normalMax,
    ),
    highMaxBpsPerSqrtMin: percentile(sorted, VOL_BIN_TRAINING_PERCENTILES.highMax),
  };
}

/**
 * Walks a dense (gaps allowed) sequence of close prices and returns
 * three parallel arrays indexed by minutes-since-first-candle:
 *
 *   closeAt[i]      = close price at that minute (e8 bigint), or null
 *   returnAt[i]     = bps return from minute i-1 → i, or null
 *   recentVolAt[i]  = RMS of last `volLookbackMin` returns ending at
 *                     minute i-1 (i.e. STRICTLY pre-decision), or null
 *
 * `recentVolAt` is null when fewer than `minVolSamples` non-null
 * returns are available in the lookback window — i.e. the start of
 * the series and any region with too many gaps.
 */
export function buildSeriesArrays(args: {
  closes: readonly ClosePoint[];
  volLookbackMin: number;
  minVolSamples?: number;
}): Readonly<{
  baseMs: number;
  totalMinutes: number;
  closeAt: ReadonlyArray<bigint | null>;
  returnAt: ReadonlyArray<number | null>;
  recentVolAt: ReadonlyArray<number | null>;
}> {
  if (args.closes.length === 0) {
    return {
      baseMs: 0,
      totalMinutes: 0,
      closeAt: [],
      returnAt: [],
      recentVolAt: [],
    };
  }
  const baseMs = args.closes[0]!.tsMs;
  const lastMs = args.closes[args.closes.length - 1]!.tsMs;
  const totalMinutes = Math.round((lastMs - baseMs) / 60_000) + 1;

  const closeAt: Array<bigint | null> = new Array(totalMinutes).fill(null);
  for (const c of args.closes) {
    const idx = Math.round((c.tsMs - baseMs) / 60_000);
    if (idx >= 0 && idx < totalMinutes) {
      closeAt[idx] = c.closeE8;
    }
  }

  const returnAt: Array<number | null> = new Array(totalMinutes).fill(null);
  for (let i = 1; i < totalMinutes; i++) {
    const prev = closeAt[i - 1];
    const curr = closeAt[i];
    if (prev != null && curr != null && prev > 0n) {
      returnAt[i] = bpsChange(curr, prev);
    }
  }

  const minSamples =
    args.minVolSamples ?? Math.max(5, Math.floor(args.volLookbackMin / 2));
  const recentVolAt: Array<number | null> = new Array(totalMinutes).fill(null);
  for (let i = 0; i < totalMinutes; i++) {
    const start = i - args.volLookbackMin;
    if (start < 0) {continue;}
    let sumSq = 0;
    let n = 0;
    for (let j = start; j < i; j++) {
      const r = returnAt[j];
      if (r != null) {
        sumSq += r * r;
        n++;
      }
    }
    if (n >= minSamples) {
      recentVolAt[i] = Math.sqrt(sumSq / n);
    }
  }

  return { baseMs, totalMinutes, closeAt, returnAt, recentVolAt };
}

/**
 * Build the win-probability grid from a sequence of close prices.
 *
 * For each minute that can serve as an interval start (i.e. the
 * full-interval close is also available), generate one decision row
 * per `decisionRemainingSecs` value. Pool Up and Down trades by side:
 * the bucket records `current_side_won`, not the absolute direction.
 * (Symmetry is a simplification — measurable up/down skew can be
 * carved out later by splitting the grid in two.)
 *
 * Volatility binning uses the empirical distribution of decision-time
 * `recent_vol` values from this run. The returned thresholds become
 * part of the wiggler config so the runtime applies the same binning.
 *
 * The Wilson lower bound on each bucket is the conservative win-rate
 * wiggler will compare against an executable Polymarket ask. Buckets
 * with `count < min_bucket_count` should be treated as no-trade by
 * wiggler (the threshold is policy, not data — applied at runtime).
 */
export function buildWinProbGrid(args: {
  closes: readonly ClosePoint[];
  intervalSec: number;
  /** Decision points by remaining-seconds. Default: integer minutes. */
  decisionRemainingSecs?: readonly number[];
  volLookbackMin?: number;
  absDBpsBoundaries?: readonly number[];
  /** z for Wilson lower bound. Default 1.6449 (95% one-sided). */
  wilsonZ?: number;
  /**
   * Anchor stride in minutes. Default 1 (rolling, every minute is a
   * candidate market start). Set to `intervalSec/60` to restrict to
   * boundary-aligned market starts (the actual Polymarket event cadence
   * for fixed-window markets) — useful as a validation pass against
   * the rolling-anchor training pass.
   */
  anchorStepMin?: number;
}): WinProbGrid {
  const intervalSec = args.intervalSec;
  if (intervalSec % 60 !== 0 || intervalSec < 120) {
    throw new Error(
      `intervalSec must be a positive multiple of 60 ≥ 120, got ${intervalSec}`,
    );
  }
  const intervalMin = intervalSec / 60;
  const anchorStepMin = args.anchorStepMin ?? 1;
  if (anchorStepMin <= 0 || !Number.isInteger(anchorStepMin)) {
    throw new Error(
      `anchorStepMin must be a positive integer, got ${anchorStepMin}`,
    );
  }
  const decisionRemainingSecs =
    args.decisionRemainingSecs ??
    // Default: every integer-minute decision boundary inside the
    // interval, e.g. 60, 120, 180, 240 for a 5m market.
    Array.from({ length: intervalMin - 1 }, (_, k) => (k + 1) * 60);
  for (const r of decisionRemainingSecs) {
    if (r <= 0 || r >= intervalSec || r % 60 !== 0) {
      throw new Error(
        `decisionRemainingSecs entries must be 60-aligned and in (0, ${intervalSec}), got ${r}`,
      );
    }
  }
  const volLookbackMin = args.volLookbackMin ?? 30;
  const absDBpsBoundaries = args.absDBpsBoundaries ?? DEFAULT_ABS_D_BPS_BOUNDARIES;
  if (absDBpsBoundaries.length === 0 || absDBpsBoundaries[0] !== 0) {
    throw new Error("absDBpsBoundaries must start at 0");
  }
  for (let i = 1; i < absDBpsBoundaries.length; i++) {
    if (absDBpsBoundaries[i]! <= absDBpsBoundaries[i - 1]!) {
      throw new Error("absDBpsBoundaries must be strictly ascending");
    }
  }

  const series = buildSeriesArrays({
    closes: args.closes,
    volLookbackMin,
  });

  // First pass: collect decision-time recent-vol values so we can
  // derive the bin thresholds before bucketing.
  const decisionVolValues: number[] = [];
  for (let i = 0; i + intervalMin < series.totalMinutes; i += anchorStepMin) {
    const line = series.closeAt[i];
    const finalPx = series.closeAt[i + intervalMin];
    if (line == null || finalPx == null || line <= 0n) {continue;}
    for (const remainingSec of decisionRemainingSecs) {
      const elapsedSec = intervalSec - remainingSec;
      const elapsedMin = elapsedSec / 60;
      const decisionIdx = i + elapsedMin;
      const current = series.closeAt[decisionIdx];
      if (current == null || current <= 0n) {continue;}
      const vol = series.recentVolAt[decisionIdx];
      if (vol == null) {continue;}
      decisionVolValues.push(vol);
    }
  }
  if (decisionVolValues.length === 0) {
    return {
      intervalSec,
      anchorStepMin,
      decisionRemainingSecs,
      absDBpsBoundaries,
      volBinThresholds: {
        lowMaxBpsPerSqrtMin: 0,
        normalMaxBpsPerSqrtMin: 0,
        highMaxBpsPerSqrtMin: 0,
      },
      totalRows: 0,
      upWinAnchors: 0,
      downWinAnchors: 0,
      firstAnchorOpenTimeMs: null,
      lastIntervalEndOpenTimeMs: null,
      buckets: [],
    };
  }
  const volBinThresholds = deriveVolBinThresholds(decisionVolValues);

  // Second pass: bucket and aggregate.
  const counters = new Map<string, { count: number; wins: number }>();
  let totalRows = 0;
  let upWinAnchors = 0;
  let downWinAnchors = 0;
  let firstAnchorOpenTimeMs: number | null = null;
  let lastIntervalEndOpenTimeMs: number | null = null;

  for (let i = 0; i + intervalMin < series.totalMinutes; i += anchorStepMin) {
    const line = series.closeAt[i];
    const finalPx = series.closeAt[i + intervalMin];
    if (line == null || finalPx == null || line <= 0n) {continue;}
    const winningSide: "up" | "down" = finalPx >= line ? "up" : "down";
    if (winningSide === "up") {
      upWinAnchors++;
    } else {
      downWinAnchors++;
    }
    const anchorMs = series.baseMs + i * 60_000;
    const intervalEndMs = series.baseMs + (i + intervalMin) * 60_000;
    if (firstAnchorOpenTimeMs === null) {
      firstAnchorOpenTimeMs = anchorMs;
    }
    lastIntervalEndOpenTimeMs = intervalEndMs;
    for (const remainingSec of decisionRemainingSecs) {
      const elapsedSec = intervalSec - remainingSec;
      const elapsedMin = elapsedSec / 60;
      const decisionIdx = i + elapsedMin;
      const current = series.closeAt[decisionIdx];
      if (current == null || current <= 0n) {continue;}
      const vol = series.recentVolAt[decisionIdx];
      if (vol == null) {continue;}
      const dBps = bpsChange(current, line);
      const absDBps = Math.abs(dBps);
      const currentSide: "up" | "down" = dBps >= 0 ? "up" : "down";
      const won = currentSide === winningSide;
      const volBin = binVol(vol, volBinThresholds);
      const bucketIdx = bucketAbsDBps(absDBps, absDBpsBoundaries);
      const key = `${remainingSec}|${volBin}|${bucketIdx}`;
      const slot = counters.get(key);
      if (slot === undefined) {
        counters.set(key, { count: 1, wins: won ? 1 : 0 });
      } else {
        slot.count++;
        if (won) {slot.wins++;}
      }
      totalRows++;
    }
  }

  // Materialize buckets in deterministic order:
  //   remainingSec ascending, vol bin in declared order, bucketIdx ascending.
  const buckets: WinProbBucket[] = [];
  for (const remainingSec of decisionRemainingSecs) {
    for (const volBin of VOL_BINS) {
      for (let bIdx = 0; bIdx < absDBpsBoundaries.length; bIdx++) {
        const key = `${remainingSec}|${volBin}|${bIdx}`;
        const slot = counters.get(key) ?? { count: 0, wins: 0 };
        const range = bucketRange(bIdx, absDBpsBoundaries);
        const pWin = slot.count === 0 ? 0 : slot.wins / slot.count;
        const pWinLower = wilsonLowerBound({
          wins: slot.wins,
          count: slot.count,
          z: args.wilsonZ,
        });
        buckets.push({
          remainingSec,
          volBin,
          absDBpsMin: range.min,
          absDBpsMax: range.max,
          count: slot.count,
          wins: slot.wins,
          pWin,
          pWinLower,
        });
      }
    }
  }

  return {
    intervalSec,
    anchorStepMin,
    decisionRemainingSecs,
    absDBpsBoundaries,
    volBinThresholds,
    totalRows,
    upWinAnchors,
    downWinAnchors,
    firstAnchorOpenTimeMs,
    lastIntervalEndOpenTimeMs,
    buckets,
  };
}
