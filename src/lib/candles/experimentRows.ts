import { bpsChange } from "@wiggler/lib/candles/lookahead";
import {
  classifyEt,
  minuteOfHourUtc,
  type Session,
  utcHour,
  type Weekday,
} from "@wiggler/lib/candles/sessions";
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
 * Per-decision-row feature set used by the experiment report. Each
 * row is one (asset, anchor, elapsed) tuple inside the OOS window.
 *
 * Path-state features are computed using ONLY data knowable at the
 * decision moment (closes from the anchor through the decision
 * candle). The same "knowable at T+60s" semantics that govern the
 * baseline grid apply here — see `winProbGrid.ts` for the timestamp
 * audit. There is no lookahead.
 *
 * Memory: ~120 bytes/row × ~150k rows/asset × 5 assets ≈ 90 MB.
 * Comfortably in-memory; we keep the whole tape so cross-experiment
 * bucketing (rules, session×vol, etc.) is one pass per dimension.
 */

export type LineCrossBucket = "0" | "1" | "2" | "3+";
export const LINE_CROSS_BUCKETS: readonly LineCrossBucket[] = [
  "0",
  "1",
  "2",
  "3+",
] as const;

export type TimeSinceCrossBucket = "never" | "<=60" | "120" | "180+";
export const TIME_SINCE_CROSS_BUCKETS: readonly TimeSinceCrossBucket[] = [
  "never",
  "<=60",
  "120",
  "180+",
] as const;

export type LeaderAgeBucket = "0-60" | "60-120" | "120-180" | "180+";
export const LEADER_AGE_BUCKETS: readonly LeaderAgeBucket[] = [
  "0-60",
  "60-120",
  "120-180",
  "180+",
] as const;

export type LeadDecayBucket =
  | "zero"
  | "0.00-0.25"
  | "0.25-0.50"
  | "0.50-0.75"
  | "0.75-1.00";
export const LEAD_DECAY_BUCKETS: readonly LeadDecayBucket[] = [
  "zero",
  "0.00-0.25",
  "0.25-0.50",
  "0.50-0.75",
  "0.75-1.00",
] as const;

export type ExperimentRow = Readonly<{
  asset: string;
  /** Index of the interval anchor in `closeAt`. Used as the
   *  distinct-interval key for opportunity counts. */
  anchorIdx: number;
  /** Wall-clock T_start of the market that contains this decision. */
  intervalStartMs: number;
  /** Wall-clock T_d of the decision moment. */
  decisionWallClockMs: number;
  remainingSec: number;

  // ---- Baseline grid lookup ----
  pWinLower: number;
  pWin: number;
  /** False if the bucket isn't tradable per `min_bucket_count`. We
   *  STILL emit the row so OOS calibration on untradable cells can be
   *  inspected; rule overlays should respect tradability. */
  tradable: boolean;
  won: boolean;
  volBin: VolBin;
  sideLeading: SideLeading;
  absDBpsBucketIdx: number;
  /** |bps_change(current, line)| at decision time. */
  currentAbsDBps: number;

  // ---- Time / session (computed from decisionWallClockMs) ----
  session: Session;
  etWeekday: Weekday;
  etHour: number;
  utcHour: number;
  /** Minute-of-hour of T_start (UTC). Polymarket markets start on
   *  fixed UTC clock boundaries. 0, 5, 10, ..., 55 for boundary mode. */
  slotMinute: number;

  // ---- Per-row return stats (for distributional summaries) ----
  /** |1m return ending at decision|. Always defined: closeAt[i+E-1]
   *  is the anchor itself when E=1. For E=1 this is |bps(decision,
   *  line)| which equals currentAbsDBps. For E>1 it's the per-minute
   *  return into the decision moment. */
  oneMinAbsReturnBps: number;
  /** |bps(final, line)| — characteristic of the whole interval the
   *  row belongs to. Same value for all 4 decision rows of the same
   *  market. */
  fiveMinAbsReturnBps: number;

  // ---- Path-state features ----
  lineCrossCount: number;
  lineCrossBucket: LineCrossBucket;
  timeSinceLastCrossSec: number | null;
  timeSinceLastCrossBucket: TimeSinceCrossBucket;
  currentLeaderAgeSec: number;
  leaderAgeBucket: LeaderAgeBucket;

  returnLast60sBps: number;
  returnLast120sBps: number | null;
  /** True iff `return_last_60s` has the same sign as the current
   *  leader. `at_line` decisions (current side = up by tie-break)
   *  treat the sign of the side as +1. */
  momentumAligned60s: boolean;
  momentumAligned120s: boolean | null;
  /** True iff current side is leading (i.e. d_bps > 0 → up_leading or
   *  d_bps < 0 → down_leading) AND the most-recent 60s move went
   *  against the leader. `at_line` rows are never retracing. */
  retracing60s: boolean;

  maxAbsDBpsSoFar: number;
  /** `current_abs_d_bps / max_abs_d_bps_so_far`, or null when
   *  `max_abs_d_bps_so_far == 0` (caller bucketizes that case as
   *  `"zero"`). */
  leadDecayRatio: number | null;
  leadDecayBucket: LeadDecayBucket;
}>;

/**
 * Build the (remaining_sec, vol_bin, side_leading, abs_d_bps_idx) →
 * { p_win_lower, p_win, tradable } lookup from a baseline config.
 */
function buildGridLookup(config: WigglerProbGridConfig): Map<
  string,
  { pWinLower: number; pWin: number; tradable: boolean }
> {
  const out = new Map<
    string,
    { pWinLower: number; pWin: number; tradable: boolean }
  >();
  for (const cell of config.grid) {
    const idx = config.abs_d_bps_boundaries.indexOf(cell.abs_d_bps_min);
    if (idx < 0) {continue;}
    const key = `${cell.remaining_sec}|${cell.vol_bin}|${cell.side_leading}|${idx}`;
    out.set(key, {
      pWinLower: cell.p_win_lower,
      pWin: cell.p_win,
      tradable: cell.tradable,
    });
  }
  return out;
}

/**
 * Walks every OOS interval anchor (i.e. anchor `open_time ≥
 * testStartMs`) for the given asset, replays decision states, and
 * emits one `ExperimentRow` per (anchor, elapsed) pair where:
 *
 *   - all required closes are present and positive
 *   - decision-time recent vol is populated
 *   - the bucket exists in the baseline grid lookup (no orphan rows)
 *
 * The returned array is ordered by anchor index ascending, then by
 * elapsed ascending — which matches the natural decision order.
 */
export function buildOosExperimentRows(args: {
  asset: string;
  closes: readonly ClosePoint[];
  baselineConfig: WigglerProbGridConfig;
  volLookbackMin: number;
  testStartMs: number;
  /** Anchor stride. Boundary mode = `intervalSec / 60`. */
  anchorStepMin: number;
}): readonly ExperimentRow[] {
  const intervalSec = args.baselineConfig.interval_sec;
  const intervalMin = intervalSec / 60;
  const decisionRemainingSecs = args.baselineConfig.remaining_sec_buckets;
  const absDBpsBoundaries = args.baselineConfig.abs_d_bps_boundaries;
  const volThresholds =
    args.baselineConfig.vol_bins.thresholds_bps_per_sqrt_min;
  const lookup = buildGridLookup(args.baselineConfig);

  const series = buildSeriesArrays({
    closes: args.closes,
    volLookbackMin: args.volLookbackMin,
  });

  const rows: ExperimentRow[] = [];

  for (let i = 0; i + intervalMin < series.totalMinutes; i += args.anchorStepMin) {
    const anchorMs = series.baseMs + i * 60_000;
    if (anchorMs < args.testStartMs) {continue;}
    const line = series.closeAt[i];
    const finalPx = series.closeAt[i + intervalMin];
    if (line == null || finalPx == null || line <= 0n) {continue;}
    const winningSide: "up" | "down" = finalPx >= line ? "up" : "down";
    const intervalStartMs = anchorMs + 60_000;
    const fiveMinAbsReturnBps = Math.abs(bpsChange(finalPx, line));

    // Walk the interior path once per anchor; record d_bps + sign per
    // elapsed minute. We DON'T accumulate global cross-count / max
    // here — a decision at elapsed=E must only see crosses inside
    // [1..E], not the rest of the interval. Per-elapsed local
    // recompute is cheap (intervalMin is 5).
    /** All d_bps values, indexed 0..intervalMin-1 corresponding to
     *  elapsed = 1..intervalMin. */
    const dBpsByElapsed: number[] = [];
    /** Sign by elapsed, same indexing as dBpsByElapsed. */
    const signByElapsed: number[] = [];
    for (let elapsedMin = 1; elapsedMin <= intervalMin - 1; elapsedMin++) {
      const decisionIdx = i + elapsedMin;
      const current = series.closeAt[decisionIdx];
      if (current != null && current > 0n) {
        const dBps = bpsChange(current, line);
        dBpsByElapsed.push(dBps);
        signByElapsed.push(Math.sign(dBps));
      } else {
        dBpsByElapsed.push(0);
        signByElapsed.push(0);
      }
    }

    // Now emit decision rows for each requested remaining_sec.
    for (const remainingSec of decisionRemainingSecs) {
      const elapsedSec = intervalSec - remainingSec;
      const elapsedMin = elapsedSec / 60;
      if (elapsedMin < 1 || elapsedMin > intervalMin - 1) {continue;}
      const decisionIdx = i + elapsedMin;
      const current = series.closeAt[decisionIdx];
      if (current == null || current <= 0n) {continue;}
      const vol = series.recentVolAt[decisionIdx];
      if (vol == null) {continue;}
      const dBps = bpsChange(current, line);
      const absDBps = Math.abs(dBps);
      const sideLeading: SideLeading =
        dBps > 0 ? "up_leading" : dBps < 0 ? "down_leading" : "at_line";
      const currentSide: "up" | "down" = dBps >= 0 ? "up" : "down";
      const won = currentSide === winningSide;
      const volBin: VolBin = binVol(vol, volThresholds);
      const bucketIdx = bucketAbsDBps(absDBps, absDBpsBoundaries);
      const lookupKey = `${remainingSec}|${volBin}|${sideLeading}|${bucketIdx}`;
      const slot = lookup.get(lookupKey);
      if (slot === undefined) {continue;}

      const decisionWallClockMs = anchorMs + (elapsedMin + 1) * 60_000;
      const et = classifyEt(decisionWallClockMs);

      // 1m return: from decisionIdx-1 to decisionIdx.
      const prevClose = series.closeAt[decisionIdx - 1];
      const oneMinAbsReturnBps =
        prevClose != null && prevClose > 0n
          ? Math.abs(bpsChange(current, prevClose))
          : 0;

      // Recompute path features using the snapshot up to elapsedMin.
      // `dBpsByElapsed` is a contiguous prefix of the path; we only
      // look at indices [0, elapsedMin-1].
      const sliceEnd = elapsedMin; // elapsed=k uses indices 0..k-1 (i.e. dBps for elapsed 1..k).
      // Recompute crossCount / lastCross strictly within [1..elapsedMin]
      // — global crossCount may include later flips not yet observed.
      let localCrossCount = 0;
      let localLastCrossElapsed = -1;
      let prevLocalSign = 0;
      for (let k = 0; k < sliceEnd; k++) {
        const sk = signByElapsed[k]!;
        if (k > 0 && prevLocalSign !== 0 && sk !== 0 && prevLocalSign !== sk) {
          localCrossCount++;
          localLastCrossElapsed = k + 1; // k is 0-indexed; elapsedMin starts at 1
        }
        if (sk !== 0) {prevLocalSign = sk;}
      }
      const lineCrossBucket: LineCrossBucket =
        localCrossCount === 0
          ? "0"
          : localCrossCount === 1
            ? "1"
            : localCrossCount === 2
              ? "2"
              : "3+";
      const timeSinceLastCrossSec =
        localLastCrossElapsed === -1
          ? null
          : (elapsedMin - localLastCrossElapsed) * 60;
      const timeSinceLastCrossBucket: TimeSinceCrossBucket =
        timeSinceLastCrossSec === null
          ? "never"
          : timeSinceLastCrossSec <= 60
            ? "<=60"
            : timeSinceLastCrossSec <= 120
              ? "120"
              : "180+";

      // Leader age: walk back from elapsedMin while sign matches.
      const decisionSign = signByElapsed[elapsedMin - 1]!;
      let ageMin = 1;
      for (let k = elapsedMin - 2; k >= 0; k--) {
        const sk = signByElapsed[k]!;
        // For at-line (sign==0) decisions, treat the run as at-line
        // matching at-line; flips between at-line and a defined side
        // break the run.
        if (sk === decisionSign) {
          ageMin++;
        } else {
          break;
        }
      }
      const currentLeaderAgeSec = ageMin * 60;
      const leaderAgeBucket: LeaderAgeBucket =
        currentLeaderAgeSec < 60
          ? "0-60"
          : currentLeaderAgeSec < 120
            ? "60-120"
            : currentLeaderAgeSec < 180
              ? "120-180"
              : "180+";

      // Recent-momentum returns relative to decision close.
      const close120sBack = series.closeAt[decisionIdx - 2];
      const returnLast60sBps =
        prevClose != null && prevClose > 0n
          ? bpsChange(current, prevClose)
          : 0;
      const returnLast120sBps =
        close120sBack != null && close120sBack > 0n
          ? bpsChange(current, close120sBack)
          : null;
      // Sign of current leader; at_line treats up-side per tie-to-Up.
      const leaderSign = sideLeading === "down_leading" ? -1 : 1;
      const momentumAligned60s = Math.sign(returnLast60sBps) === leaderSign;
      const momentumAligned120s =
        returnLast120sBps === null
          ? null
          : Math.sign(returnLast120sBps) === leaderSign;
      const retracing60s =
        sideLeading !== "at_line" && Math.sign(returnLast60sBps) !== leaderSign;

      // Lead decay: max abs d_bps observed within [1..elapsedMin].
      let localMax = 0;
      for (let k = 0; k < sliceEnd; k++) {
        const ad = Math.abs(dBpsByElapsed[k]!);
        if (ad > localMax) {localMax = ad;}
      }
      const leadDecayRatio = localMax === 0 ? null : absDBps / localMax;
      const leadDecayBucket: LeadDecayBucket =
        leadDecayRatio === null
          ? "zero"
          : leadDecayRatio < 0.25
            ? "0.00-0.25"
            : leadDecayRatio < 0.5
              ? "0.25-0.50"
              : leadDecayRatio < 0.75
                ? "0.50-0.75"
                : "0.75-1.00";

      rows.push({
        asset: args.asset.toUpperCase(),
        anchorIdx: i,
        intervalStartMs,
        decisionWallClockMs,
        remainingSec,
        pWinLower: slot.pWinLower,
        pWin: slot.pWin,
        tradable: slot.tradable,
        won,
        volBin,
        sideLeading,
        absDBpsBucketIdx: bucketIdx,
        currentAbsDBps: absDBps,
        session: et.session,
        etWeekday: et.weekdayShort,
        etHour: et.etHour,
        utcHour: utcHour(decisionWallClockMs),
        slotMinute: minuteOfHourUtc(intervalStartMs),
        oneMinAbsReturnBps,
        fiveMinAbsReturnBps,
        lineCrossCount: localCrossCount,
        lineCrossBucket,
        timeSinceLastCrossSec,
        timeSinceLastCrossBucket,
        currentLeaderAgeSec,
        leaderAgeBucket,
        returnLast60sBps,
        returnLast120sBps,
        momentumAligned60s,
        momentumAligned120s,
        retracing60s,
        maxAbsDBpsSoFar: localMax,
        leadDecayRatio,
        leadDecayBucket,
      });
    }
  }
  return rows;
}
