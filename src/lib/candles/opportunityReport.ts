import { bpsChange } from "@wiggler/lib/candles/lookahead";
import {
  binVol,
  bucketAbsDBps,
  buildSeriesArrays,
  type ClosePoint,
  type SideLeading,
  type VolBin,
} from "@wiggler/lib/candles/winProbGrid";
import type { WigglerProbGridConfig } from "@wiggler/lib/candles/winProbGridConfig";

/**
 * Opportunity report: how often did historical decision states reach a
 * given confidence threshold? Answers "would the model produce enough
 * tradeable signals to bother?" without requiring an order-book
 * backtest.
 *
 * Replays decision states from the original close-price series and
 * counts BOTH:
 *
 *   - rows_above: how many decision rows had `p_win_lower ≥ T` AND
 *     came from a tradable bucket. (Bucket-level signal count.)
 *   - intervals_signaling: how many DISTINCT 5-minute markets had at
 *     least one decision row that crossed the threshold. (Trade-level
 *     opportunity count — four 60s/120s/180s/240s rows in the same
 *     market are one trade opportunity, not four.)
 *
 * Untradable cells (`count < min_bucket_count`) are skipped — wiggler
 * would refuse them anyway.
 */

export const DEFAULT_OPPORTUNITY_THRESHOLDS: readonly number[] = [
  0.7, 0.8, 0.9, 0.95, 0.98,
] as const;

export type OpportunityRow = Readonly<{
  threshold: number;
  rowsAbove: number;
  intervalsSignaling: number;
  rowsPerDay: number;
  intervalsPerDay: number;
  /** Avg signals per signaling interval — high values mean the model
   *  fires multiple times per market (typical near expiry); low
   *  values mean the signal is fleeting. */
  meanRowsPerSignalingInterval: number;
  byRemainingSec: ReadonlyArray<{ remainingSec: number; rows: number }>;
  byVolBin: ReadonlyArray<{ volBin: string; rows: number }>;
}>;

export type OpportunityReport = Readonly<{
  asset: string;
  intervalSec: number;
  anchorMode: "rolling" | "boundary";
  windowDays: number;
  /** Decision rows scanned that landed in tradable cells. */
  tradableRowsScanned: number;
  /** Distinct intervals scanned (one per anchor that yielded ≥ 1 row). */
  intervalsScanned: number;
  rows: readonly OpportunityRow[];
}>;

/**
 * Re-scans the same close-price series the grid was trained on,
 * looks up `p_win_lower` for each decision row from the cached
 * config, and counts per-threshold bucket-level + interval-level
 * signals. Untradable cells are excluded.
 */
export function buildOpportunityReport(args: {
  config: WigglerProbGridConfig;
  closes: readonly ClosePoint[];
  volLookbackMin: number;
  thresholds?: readonly number[];
}): OpportunityReport {
  const thresholds = args.thresholds ?? DEFAULT_OPPORTUNITY_THRESHOLDS;
  const intervalSec = args.config.interval_sec;
  const intervalMin = intervalSec / 60;
  const decisionRemainingSecs = args.config.remaining_sec_buckets;
  const absDBpsBoundaries = args.config.abs_d_bps_boundaries;
  const volThresholds = args.config.vol_bins.thresholds_bps_per_sqrt_min;
  const anchorStepMin = args.config.anchor_mode === "boundary" ? intervalMin : 1;

  // Lookup: bucket key -> { p_win_lower, tradable }.
  const lookup = new Map<string, { pWinLower: number; tradable: boolean }>();
  for (const cell of args.config.grid) {
    const idx = absDBpsBoundaries.indexOf(cell.abs_d_bps_min);
    if (idx < 0) {continue;}
    const key = `${cell.remaining_sec}|${cell.vol_bin}|${cell.side_leading}|${idx}`;
    lookup.set(key, { pWinLower: cell.p_win_lower, tradable: cell.tradable });
  }

  const series = buildSeriesArrays({
    closes: args.closes,
    volLookbackMin: args.volLookbackMin,
  });

  // Per-threshold accumulators.
  type Slot = {
    rowsAbove: number;
    intervalsSignaling: Set<number>;
    perRemainingSec: Map<number, number>;
    perVolBin: Map<string, number>;
  };
  const slots = new Map<number, Slot>();
  for (const t of thresholds) {
    slots.set(t, {
      rowsAbove: 0,
      intervalsSignaling: new Set<number>(),
      perRemainingSec: new Map(),
      perVolBin: new Map(),
    });
  }

  let tradableRowsScanned = 0;
  const intervalsScanned = new Set<number>();

  for (let i = 0; i + intervalMin < series.totalMinutes; i += anchorStepMin) {
    const line = series.closeAt[i];
    const finalPx = series.closeAt[i + intervalMin];
    if (line == null || finalPx == null || line <= 0n) {continue;}
    let intervalContributed = false;
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
      const sideLeading: SideLeading =
        dBps > 0 ? "up_leading" : dBps < 0 ? "down_leading" : "at_line";
      const volBin: VolBin = binVol(vol, volThresholds);
      const bucketIdx = bucketAbsDBps(absDBps, absDBpsBoundaries);
      const key = `${remainingSec}|${volBin}|${sideLeading}|${bucketIdx}`;
      const cell = lookup.get(key);
      if (cell === undefined || !cell.tradable) {continue;}
      tradableRowsScanned++;
      intervalContributed = true;
      for (const t of thresholds) {
        if (cell.pWinLower < t) {continue;}
        const slot = slots.get(t)!;
        slot.rowsAbove++;
        slot.intervalsSignaling.add(i);
        slot.perRemainingSec.set(
          remainingSec,
          (slot.perRemainingSec.get(remainingSec) ?? 0) + 1,
        );
        slot.perVolBin.set(volBin, (slot.perVolBin.get(volBin) ?? 0) + 1);
      }
    }
    if (intervalContributed) {
      intervalsScanned.add(i);
    }
  }

  const windowMs =
    args.config.training_input.window_start_ms !== null &&
    args.config.training_input.window_end_ms !== null
      ? args.config.training_input.window_end_ms -
        args.config.training_input.window_start_ms
      : 0;
  const windowDays = windowMs > 0 ? windowMs / 86_400_000 : 1;

  const rows: OpportunityRow[] = thresholds.map((threshold) => {
    const slot = slots.get(threshold)!;
    const intervals = slot.intervalsSignaling.size;
    const meanRowsPerInt =
      intervals === 0 ? 0 : slot.rowsAbove / intervals;
    const byRemainingSec = [...slot.perRemainingSec.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([remainingSec, rows]) => ({ remainingSec, rows }));
    const byVolBin = [...slot.perVolBin.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([volBin, rows]) => ({ volBin, rows }));
    return {
      threshold,
      rowsAbove: slot.rowsAbove,
      intervalsSignaling: intervals,
      rowsPerDay: windowDays > 0 ? slot.rowsAbove / windowDays : 0,
      intervalsPerDay: windowDays > 0 ? intervals / windowDays : 0,
      meanRowsPerSignalingInterval: meanRowsPerInt,
      byRemainingSec,
      byVolBin,
    };
  });

  return {
    asset: args.config.asset,
    intervalSec: args.config.interval_sec,
    anchorMode: args.config.anchor_mode,
    windowDays,
    tradableRowsScanned,
    intervalsScanned: intervalsScanned.size,
    rows,
  };
}
