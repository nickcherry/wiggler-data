import { bpsChange } from "@wiggler/lib/candles/lookahead";
import {
  binVol,
  bucketAbsDBps,
  buildSeriesArrays,
  type ClosePoint,
  type VolBin,
} from "@wiggler/lib/candles/winProbGrid";
import type { WigglerProbGridConfig } from "@wiggler/lib/candles/winProbGridConfig";

/**
 * Calibration report: rebins decision states by their `p_win_lower`
 * lookup value (i.e. the conservative probability wiggler would have
 * traded against) and reports the realized win rate inside each bin.
 *
 * What we want to see:
 *
 *   p_win_lower bin    realized win rate
 *   -----------------  -----------------
 *   [0.50, 0.60)       ~0.55     (close to mid)
 *   [0.60, 0.70)       ~0.65
 *   ...
 *   [0.95, 0.98)       ~0.96
 *   [0.98, 1.00)       ~0.99
 *
 * Buckets where realized < lower-bound mean the lower bound is
 * miscalibrated (over-promising) — likely a regime-shift symptom
 * (training data does not represent live data) and a strong reason
 * not to trust the highest-confidence cells. Buckets where realized
 * is much higher than predicted are conservative — fine, but worth
 * noting because we may be leaving EV on the table.
 *
 * Regenerates decision states from the same close-price series the
 * grid was trained on, looks up each state's `p_win_lower` from the
 * grid, and bins by that. Pure: no I/O.
 */

export type CalibrationBin = Readonly<{
  pWinLowerMin: number;
  pWinLowerMax: number;
  count: number;
  wins: number;
  realizedWinRate: number;
  meanPredicted: number;
}>;

export type CalibrationReport = Readonly<{
  asset: string;
  intervalSec: number;
  anchorMode: "rolling" | "boundary";
  /** Default 10 deciles. */
  bins: readonly CalibrationBin[];
  /** Decision states scanned. */
  totalRows: number;
  /**
   * Maximum absolute (predicted - realized) gap observed across bins.
   * Higher → the grid's lower bound is less calibrated. Useful as a
   * single-number health indicator across re-runs.
   */
  maxAbsGap: number;
}>;

const DEFAULT_BIN_BOUNDARIES: readonly number[] = [
  0, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.98, 1.0,
] as const;

/**
 * Index into `boundaries` such that `boundaries[i] ≤ value < boundaries[i+1]`.
 * Returns -1 when `value` falls outside the boundaries (defensive: we never
 * expect this since boundaries cover [0, 1] and inputs are probabilities).
 */
function pBinIndex(value: number, boundaries: readonly number[]): number {
  if (value < boundaries[0]! || value > boundaries[boundaries.length - 1]!) {
    return -1;
  }
  // Last bin is closed on the right so `value === 1.0` lands in the
  // top bin.
  for (let i = boundaries.length - 2; i >= 0; i--) {
    if (value >= boundaries[i]!) {
      return i;
    }
  }
  return 0;
}

/**
 * Lookup table: (remaining_sec, vol_bin, abs_d_bps) → p_win_lower.
 * Built once per report from the grid; O(1) lookups inside the hot
 * loop.
 */
function buildGridLookup(
  config: WigglerProbGridConfig,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const cell of config.grid) {
    // Bucket index in the boundaries array — recover by scanning.
    const idx = config.abs_d_bps_boundaries.indexOf(cell.abs_d_bps_min);
    if (idx < 0) {continue;}
    const key = `${cell.remaining_sec}|${cell.vol_bin}|${idx}`;
    out.set(key, cell.p_win_lower);
  }
  return out;
}

export function buildCalibrationReport(args: {
  config: WigglerProbGridConfig;
  closes: readonly ClosePoint[];
  volLookbackMin: number;
  binBoundaries?: readonly number[];
}): CalibrationReport {
  const intervalSec = args.config.interval_sec;
  const intervalMin = intervalSec / 60;
  const decisionRemainingSecs = args.config.remaining_sec_buckets;
  const absDBpsBoundaries = args.config.abs_d_bps_boundaries;
  const volThresholds = args.config.vol_bins.thresholds_bps_per_sqrt_min;
  const anchorStepMin = args.config.anchor_mode === "boundary" ? intervalMin : 1;
  const binBoundaries = args.binBoundaries ?? DEFAULT_BIN_BOUNDARIES;
  const lookup = buildGridLookup(args.config);

  const series = buildSeriesArrays({
    closes: args.closes,
    volLookbackMin: args.volLookbackMin,
  });

  const slots: Array<{
    pWinLowerMin: number;
    pWinLowerMax: number;
    count: number;
    wins: number;
    sumPredicted: number;
  }> = [];
  for (let i = 0; i < binBoundaries.length - 1; i++) {
    slots.push({
      pWinLowerMin: binBoundaries[i]!,
      pWinLowerMax: binBoundaries[i + 1]!,
      count: 0,
      wins: 0,
      sumPredicted: 0,
    });
  }

  let totalRows = 0;

  // Identical traversal to buildWinProbGrid — replay the same anchors
  // and decisions so the calibration is on the same population the
  // grid claims to predict.
  for (let i = 0; i + intervalMin < series.totalMinutes; i += anchorStepMin) {
    const line = series.closeAt[i];
    const finalPx = series.closeAt[i + intervalMin];
    if (line == null || finalPx == null || line <= 0n) {continue;}
    const winningSide: "up" | "down" = finalPx >= line ? "up" : "down";
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
      const volBin: VolBin = binVol(vol, volThresholds);
      const bucketIdx = bucketAbsDBps(absDBps, absDBpsBoundaries);
      const key = `${remainingSec}|${volBin}|${bucketIdx}`;
      const pWinLower = lookup.get(key);
      if (pWinLower === undefined) {continue;}
      const slotIdx = pBinIndex(pWinLower, binBoundaries);
      if (slotIdx < 0) {continue;}
      const slot = slots[slotIdx]!;
      slot.count++;
      if (won) {slot.wins++;}
      slot.sumPredicted += pWinLower;
      totalRows++;
    }
  }

  const bins: CalibrationBin[] = slots.map((s) => {
    const realized = s.count === 0 ? 0 : s.wins / s.count;
    const meanPredicted = s.count === 0 ? 0 : s.sumPredicted / s.count;
    return {
      pWinLowerMin: s.pWinLowerMin,
      pWinLowerMax: s.pWinLowerMax,
      count: s.count,
      wins: s.wins,
      realizedWinRate: realized,
      meanPredicted,
    };
  });

  let maxAbsGap = 0;
  for (const bin of bins) {
    if (bin.count === 0) {continue;}
    const gap = Math.abs(bin.realizedWinRate - bin.meanPredicted);
    if (gap > maxAbsGap) {maxAbsGap = gap;}
  }

  return {
    asset: args.config.asset,
    intervalSec: args.config.interval_sec,
    anchorMode: args.config.anchor_mode,
    bins,
    totalRows,
    maxAbsGap,
  };
}

