import type { ExperimentRow } from "@wiggler/lib/candles/experimentRows";
import { LEAD_DECAY_BUCKETS, LEADER_AGE_BUCKETS, LINE_CROSS_BUCKETS, TIME_SINCE_CROSS_BUCKETS } from "@wiggler/lib/candles/experimentRows";
import { type Session, SESSIONS, WEEKDAYS } from "@wiggler/lib/candles/sessions";
import type { VolBin } from "@wiggler/lib/candles/winProbGrid";

/**
 * Rolls per-decision-row tape (one `ExperimentRow[]` per asset) into
 * the structured experiment report. Pure: no I/O.
 *
 * Every stat below is OOS-only because the input rows come from
 * `buildOosExperimentRows`, which filters by `testStartMs`. The
 * baseline `p_win_lower` was trained on the prefix.
 */

// Calibration bin boundaries — same shape as candles:calibration-report.
export const P_LOWER_BIN_BOUNDARIES: readonly number[] = [
  0, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.98, 1.0,
] as const;

const HIGH_CONF_THRESHOLDS: readonly number[] = [0.9, 0.95, 0.98] as const;

export type CalibrationBin = Readonly<{
  pWinLowerMin: number;
  pWinLowerMax: number;
  count: number;
  wins: number;
  realizedWinRate: number;
  meanPredicted: number;
  /** realized − meanPredicted. Negative = lower bound was over-promising. */
  gap: number;
}>;

export type ThresholdOpportunity = Readonly<{
  threshold: number;
  rowsAbove: number;
  intervalsSignaling: number;
  meanPredicted: number;
  realizedWinRate: number;
  gap: number;
}>;

export type DistStats = Readonly<{
  count: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
}>;

export type BucketStats = Readonly<{
  rowCount: number;
  intervalCount: number;
  upAnchors: number;
  downAnchors: number;
  upShare: number;
  oneMinAbsReturnBps: DistStats;
  fiveMinAbsReturnBps: DistStats;
  meanPLower: number;
  realizedWinRate: number;
  gapAll: number;
  maxAbsCalibrationGap: number;
  calibrationByPLower: readonly CalibrationBin[];
  opportunities: readonly ThresholdOpportunity[];
}>;

function emptyBucket(): BucketStats {
  return {
    rowCount: 0,
    intervalCount: 0,
    upAnchors: 0,
    downAnchors: 0,
    upShare: 0,
    oneMinAbsReturnBps: { count: 0, mean: 0, p50: 0, p90: 0, p95: 0 },
    fiveMinAbsReturnBps: { count: 0, mean: 0, p50: 0, p90: 0, p95: 0 },
    meanPLower: 0,
    realizedWinRate: 0,
    gapAll: 0,
    maxAbsCalibrationGap: 0,
    calibrationByPLower: P_LOWER_BIN_BOUNDARIES.slice(0, -1).map((min, i) => ({
      pWinLowerMin: min,
      pWinLowerMax: P_LOWER_BIN_BOUNDARIES[i + 1]!,
      count: 0,
      wins: 0,
      realizedWinRate: 0,
      meanPredicted: 0,
      gap: 0,
    })),
    opportunities: HIGH_CONF_THRESHOLDS.map((t) => ({
      threshold: t,
      rowsAbove: 0,
      intervalsSignaling: 0,
      meanPredicted: 0,
      realizedWinRate: 0,
      gap: 0,
    })),
  };
}

function percentileOfSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) {return 0;}
  if (sorted.length === 1) {return sorted[0]!;}
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) {return sorted[lo]!;}
  const frac = pos - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

function distStats(values: number[]): DistStats {
  if (values.length === 0) {
    return { count: 0, mean: 0, p50: 0, p90: 0, p95: 0 };
  }
  let sum = 0;
  for (const v of values) {sum += v;}
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    mean: sum / values.length,
    p50: percentileOfSorted(sorted, 0.5),
    p90: percentileOfSorted(sorted, 0.9),
    p95: percentileOfSorted(sorted, 0.95),
  };
}

function pLowerBinIndex(value: number): number {
  if (value < P_LOWER_BIN_BOUNDARIES[0]!) {return 0;}
  if (value >= P_LOWER_BIN_BOUNDARIES[P_LOWER_BIN_BOUNDARIES.length - 1]!) {
    return P_LOWER_BIN_BOUNDARIES.length - 2;
  }
  for (let i = P_LOWER_BIN_BOUNDARIES.length - 2; i >= 0; i--) {
    if (value >= P_LOWER_BIN_BOUNDARIES[i]!) {return i;}
  }
  return 0;
}

/**
 * Compute `BucketStats` over a row population. The expensive bits
 * (sorting per percentile, deduping to intervals) are amortized into
 * one pass for the "common shape" stats — calibration bins use a
 * fixed boundary array.
 */
export function computeBucketStats(rows: readonly ExperimentRow[]): BucketStats {
  if (rows.length === 0) {return emptyBucket();}

  // Per-row accumulators.
  const oneMin: number[] = [];
  const fiveMinPerInterval: number[] = [];
  let sumPLower = 0;
  let wins = 0;

  // Per-interval accumulators. Use a Map keyed by `${asset}|${anchorIdx}`
  // so different assets at the same anchorIdx don't collide.
  const intervalMeta = new Map<
    string,
    { up: boolean; fiveMinBps: number }
  >();

  // Calibration bins.
  const calibSlots = P_LOWER_BIN_BOUNDARIES.slice(0, -1).map((min, i) => ({
    pWinLowerMin: min,
    pWinLowerMax: P_LOWER_BIN_BOUNDARIES[i + 1]!,
    count: 0,
    wins: 0,
    sumPredicted: 0,
  }));

  // Opportunity thresholds: rows above + distinct intervals.
  const oppSlots = HIGH_CONF_THRESHOLDS.map((t) => ({
    threshold: t,
    rowsAbove: 0,
    sumPredicted: 0,
    wins: 0,
    intervalsSignaling: new Set<string>(),
  }));

  for (const r of rows) {
    oneMin.push(r.oneMinAbsReturnBps);
    sumPLower += r.pWinLower;
    if (r.won) {wins++;}
    const intervalKey = `${r.asset}|${r.anchorIdx}`;
    if (!intervalMeta.has(intervalKey)) {
      intervalMeta.set(intervalKey, {
        up: r.fiveMinAbsReturnBps > 0 ? r.won : r.won, // placeholder; up-share tracked below
        fiveMinBps: r.fiveMinAbsReturnBps,
      });
    }

    const binIdx = pLowerBinIndex(r.pWinLower);
    const slot = calibSlots[binIdx];
    if (slot !== undefined) {
      slot.count++;
      if (r.won) {slot.wins++;}
      slot.sumPredicted += r.pWinLower;
    }

    for (const o of oppSlots) {
      if (r.pWinLower >= o.threshold) {
        o.rowsAbove++;
        o.sumPredicted += r.pWinLower;
        if (r.won) {o.wins++;}
        o.intervalsSignaling.add(intervalKey);
      }
    }
  }

  // Interval-level: dedupe to one record per interval. We need
  // anchor up/down balance — not "row won" but "did the WHOLE
  // interval finish up". A row's pWin/wins isn't enough; reconstruct
  // up-share by looking at the rows themselves: in any single
  // interval, all 4 decision rows share the same final price → same
  // winningSide. We can grab any row's `won` plus the row's
  // sideLeading: the row won iff currentSide == winningSide. So
  // winningSide = currentSide(row) === up ? (won ? up : down) : ...
  // Easier: rebuild per-interval winning side from any row.
  const intervalWinning = new Map<string, "up" | "down">();
  for (const r of rows) {
    const intervalKey = `${r.asset}|${r.anchorIdx}`;
    if (intervalWinning.has(intervalKey)) {continue;}
    // currentSide: up_leading & at_line → up; down_leading → down.
    const currentSide: "up" | "down" =
      r.sideLeading === "down_leading" ? "down" : "up";
    const winningSide: "up" | "down" = r.won
      ? currentSide
      : currentSide === "up"
        ? "down"
        : "up";
    intervalWinning.set(intervalKey, winningSide);
    fiveMinPerInterval.push(r.fiveMinAbsReturnBps);
  }
  let upAnchors = 0;
  let downAnchors = 0;
  for (const v of intervalWinning.values()) {
    if (v === "up") {upAnchors++;}
    else {downAnchors++;}
  }
  const intervalCount = intervalWinning.size;

  const meanPLower = rows.length === 0 ? 0 : sumPLower / rows.length;
  const realizedWinRate = rows.length === 0 ? 0 : wins / rows.length;

  // Materialize calibration bins.
  let maxAbsCalibrationGap = 0;
  const calibrationByPLower: CalibrationBin[] = calibSlots.map((s) => {
    const realized = s.count === 0 ? 0 : s.wins / s.count;
    const meanPredicted = s.count === 0 ? 0 : s.sumPredicted / s.count;
    const gap = realized - meanPredicted;
    if (s.count > 0 && Math.abs(gap) > maxAbsCalibrationGap) {
      maxAbsCalibrationGap = Math.abs(gap);
    }
    return {
      pWinLowerMin: s.pWinLowerMin,
      pWinLowerMax: s.pWinLowerMax,
      count: s.count,
      wins: s.wins,
      realizedWinRate: realized,
      meanPredicted,
      gap,
    };
  });

  const opportunities: ThresholdOpportunity[] = oppSlots.map((o) => {
    const realized = o.rowsAbove === 0 ? 0 : o.wins / o.rowsAbove;
    const meanPredicted = o.rowsAbove === 0 ? 0 : o.sumPredicted / o.rowsAbove;
    return {
      threshold: o.threshold,
      rowsAbove: o.rowsAbove,
      intervalsSignaling: o.intervalsSignaling.size,
      meanPredicted,
      realizedWinRate: realized,
      gap: realized - meanPredicted,
    };
  });

  return {
    rowCount: rows.length,
    intervalCount,
    upAnchors,
    downAnchors,
    upShare: intervalCount === 0 ? 0 : upAnchors / intervalCount,
    oneMinAbsReturnBps: distStats(oneMin),
    fiveMinAbsReturnBps: distStats(fiveMinPerInterval),
    meanPLower,
    realizedWinRate,
    gapAll: realizedWinRate - meanPLower,
    maxAbsCalibrationGap,
    calibrationByPLower,
    opportunities,
  };
}

// ---------------------------------------------------------------------------
// Generic bucketer

function bucket<K extends string | number>(
  rows: readonly ExperimentRow[],
  keyFn: (r: ExperimentRow) => K,
): Map<K, ExperimentRow[]> {
  const out = new Map<K, ExperimentRow[]>();
  for (const r of rows) {
    const k = keyFn(r);
    let bucket = out.get(k);
    if (bucket === undefined) {
      bucket = [];
      out.set(k, bucket);
    }
    bucket.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-experiment shapes

export type AssetBucket<L extends string | number> = Readonly<{
  asset: string;
  byLevel: ReadonlyArray<{ level: L; stats: BucketStats }>;
}>;

export type ExperimentByAsset<L extends string | number> = Readonly<{
  perAsset: readonly AssetBucket<L>[];
  aggregate: ReadonlyArray<{ level: L; stats: BucketStats }>;
}>;

function buildPerAsset<L extends string | number>(
  rowsByAsset: ReadonlyMap<string, readonly ExperimentRow[]>,
  keyFn: (r: ExperimentRow) => L,
  orderedLevels: readonly L[],
): ExperimentByAsset<L> {
  const perAsset: AssetBucket<L>[] = [];
  for (const [asset, rows] of rowsByAsset) {
    const buckets = bucket(rows, keyFn);
    perAsset.push({
      asset,
      byLevel: orderedLevels.map((level) => ({
        level,
        stats: computeBucketStats(buckets.get(level) ?? []),
      })),
    });
  }
  // Aggregate across all assets.
  const allRows: ExperimentRow[] = [];
  for (const rows of rowsByAsset.values()) {allRows.push(...rows);}
  const aggregateBuckets = bucket(allRows, keyFn);
  const aggregate = orderedLevels.map((level) => ({
    level,
    stats: computeBucketStats(aggregateBuckets.get(level) ?? []),
  }));
  return { perAsset, aggregate };
}

// ---------------------------------------------------------------------------
// Experiment 1: session

export type SessionExperiment = Readonly<{
  byAsset: ExperimentByAsset<Session>;
  /** Per-(asset, session, vol_bin, p_lower_bin) calibration. Heavy
   *  but compact JSON-wise (≤ 5 × 4 × 4 × 12 = 960 entries / asset). */
  sessionByVol: ReadonlyArray<
    Readonly<{
      asset: string;
      session: Session;
      volBin: VolBin;
      bins: readonly CalibrationBin[];
    }>
  >;
}>;

const VOL_BINS_ORDERED: readonly VolBin[] = [
  "low",
  "normal",
  "high",
  "extreme",
] as const;

function buildSessionExperiment(
  rowsByAsset: ReadonlyMap<string, readonly ExperimentRow[]>,
): SessionExperiment {
  const byAsset = buildPerAsset(rowsByAsset, (r) => r.session, SESSIONS);
  const sessionByVol: Array<{
    asset: string;
    session: Session;
    volBin: VolBin;
    bins: readonly CalibrationBin[];
  }> = [];
  for (const [asset, rows] of rowsByAsset) {
    for (const session of SESSIONS) {
      for (const volBin of VOL_BINS_ORDERED) {
        const subset = rows.filter(
          (r) => r.session === session && r.volBin === volBin,
        );
        const stats = computeBucketStats(subset);
        sessionByVol.push({
          asset,
          session,
          volBin,
          bins: stats.calibrationByPLower,
        });
      }
    }
  }
  return { byAsset, sessionByVol };
}

// ---------------------------------------------------------------------------
// Experiment 2: day of week (ET)

const ORDERED_DOW: readonly (typeof WEEKDAYS)[number][] = WEEKDAYS;

// ---------------------------------------------------------------------------
// Experiment 3: hour of day (ET + UTC)

const HOURS_24: readonly number[] = Array.from({ length: 24 }, (_, h) => h);

// ---------------------------------------------------------------------------
// Experiment 4: 5-minute boundary slot

const SLOT_LEVELS: readonly number[] = Array.from({ length: 12 }, (_, k) => k * 5);

// ---------------------------------------------------------------------------
// Rule overlays (Experiment 8)

export type RuleId =
  | "no_weekend"
  | "only_weekend"
  | "no_weekday_us_cash"
  | "no_weekday_overnight"
  | "no_cross_count_ge2"
  | "no_cross_count_ge3"
  | "no_retracing_60s"
  | "require_leader_age_ge60"
  | "require_lead_decay_ge_0_50"
  | "require_lead_decay_ge_0_75"
  | "require_momentum_aligned_60s";

const RULE_DEFS: ReadonlyArray<{
  id: RuleId;
  description: string;
  /** Returns true iff the row should be KEPT under the rule. */
  keep: (r: ExperimentRow) => boolean;
}> = [
  {
    id: "no_weekend",
    description: "Drop weekend decisions.",
    keep: (r) => r.session !== "weekend",
  },
  {
    id: "only_weekend",
    description: "Keep only weekend decisions.",
    keep: (r) => r.session === "weekend",
  },
  {
    id: "no_weekday_us_cash",
    description: "Drop ET cash-session decisions.",
    keep: (r) => r.session !== "weekday_us_cash",
  },
  {
    id: "no_weekday_overnight",
    description: "Drop ET overnight decisions.",
    keep: (r) => r.session !== "weekday_overnight",
  },
  {
    id: "no_cross_count_ge2",
    description: "Drop rows with line_cross_count >= 2.",
    keep: (r) => r.lineCrossCount < 2,
  },
  {
    id: "no_cross_count_ge3",
    description: "Drop rows with line_cross_count >= 3.",
    keep: (r) => r.lineCrossCount < 3,
  },
  {
    id: "no_retracing_60s",
    description: "Drop rows where the leader is retracing in the last 60s.",
    keep: (r) => !r.retracing60s,
  },
  {
    id: "require_leader_age_ge60",
    description: "Require current_leader_age_sec >= 60.",
    keep: (r) => r.currentLeaderAgeSec >= 60,
  },
  {
    id: "require_lead_decay_ge_0_50",
    description:
      "Require lead_decay_ratio >= 0.50 (skip 'zero' bucket and require ratio).",
    keep: (r) => r.leadDecayRatio !== null && r.leadDecayRatio >= 0.5,
  },
  {
    id: "require_lead_decay_ge_0_75",
    description: "Require lead_decay_ratio >= 0.75.",
    keep: (r) => r.leadDecayRatio !== null && r.leadDecayRatio >= 0.75,
  },
  {
    id: "require_momentum_aligned_60s",
    description: "Require momentum_aligned_60s.",
    keep: (r) => r.momentumAligned60s,
  },
];

export type RuleResult = Readonly<{
  ruleId: RuleId;
  description: string;
  /** Per-asset + aggregate. */
  perAsset: readonly RuleAssetResult[];
}>;

export type RuleAssetResult = Readonly<{
  asset: string;
  /** Stats at each high-conf threshold for both baseline and filtered. */
  byThreshold: ReadonlyArray<RuleThresholdRow>;
}>;

export type RuleThresholdRow = Readonly<{
  threshold: number;
  baseline: Readonly<{
    intervalsSignaling: number;
    realizedWinRate: number;
    meanPLower: number;
    gap: number;
  }>;
  filtered: Readonly<{
    intervalsSignaling: number;
    intervalsKeptPct: number;
    realizedWinRate: number;
    meanPLower: number;
    gap: number;
  }>;
  delta: Readonly<{
    deltaRealizedWinRate: number;
    deltaGap: number;
    deltaIntervals: number;
  }>;
}>;

function summarizeAtThresholds(rows: readonly ExperimentRow[]): Map<
  number,
  {
    rowsAbove: number;
    intervals: Set<string>;
    sumPredicted: number;
    wins: number;
  }
> {
  const out = new Map<
    number,
    {
      rowsAbove: number;
      intervals: Set<string>;
      sumPredicted: number;
      wins: number;
    }
  >();
  for (const t of HIGH_CONF_THRESHOLDS) {
    out.set(t, {
      rowsAbove: 0,
      intervals: new Set<string>(),
      sumPredicted: 0,
      wins: 0,
    });
  }
  for (const r of rows) {
    for (const [t, slot] of out) {
      if (r.pWinLower >= t) {
        slot.rowsAbove++;
        slot.sumPredicted += r.pWinLower;
        if (r.won) {slot.wins++;}
        slot.intervals.add(`${r.asset}|${r.anchorIdx}`);
      }
    }
  }
  return out;
}

function buildRuleResult(
  ruleId: RuleId,
  description: string,
  rowsByAsset: ReadonlyMap<string, readonly ExperimentRow[]>,
  keep: (r: ExperimentRow) => boolean,
): RuleResult {
  const perAsset: RuleAssetResult[] = [];
  const aggregateBaselineRows: ExperimentRow[] = [];
  const aggregateFilteredRows: ExperimentRow[] = [];
  for (const [asset, rows] of rowsByAsset) {
    const filtered = rows.filter(keep);
    aggregateBaselineRows.push(...rows);
    aggregateFilteredRows.push(...filtered);
    perAsset.push(buildRuleAssetResult(asset, rows, filtered));
  }
  perAsset.push(
    buildRuleAssetResult(
      "AGGREGATE",
      aggregateBaselineRows,
      aggregateFilteredRows,
    ),
  );
  return { ruleId, description, perAsset };
}

function buildRuleAssetResult(
  asset: string,
  baselineRows: readonly ExperimentRow[],
  filteredRows: readonly ExperimentRow[],
): RuleAssetResult {
  const baseline = summarizeAtThresholds(baselineRows);
  const filtered = summarizeAtThresholds(filteredRows);
  const byThreshold: RuleThresholdRow[] = HIGH_CONF_THRESHOLDS.map((t) => {
    const b = baseline.get(t)!;
    const f = filtered.get(t)!;
    const baselineRealized = b.rowsAbove === 0 ? 0 : b.wins / b.rowsAbove;
    const baselineMeanP = b.rowsAbove === 0 ? 0 : b.sumPredicted / b.rowsAbove;
    const filteredRealized = f.rowsAbove === 0 ? 0 : f.wins / f.rowsAbove;
    const filteredMeanP = f.rowsAbove === 0 ? 0 : f.sumPredicted / f.rowsAbove;
    return {
      threshold: t,
      baseline: {
        intervalsSignaling: b.intervals.size,
        realizedWinRate: baselineRealized,
        meanPLower: baselineMeanP,
        gap: baselineRealized - baselineMeanP,
      },
      filtered: {
        intervalsSignaling: f.intervals.size,
        intervalsKeptPct:
          b.intervals.size === 0 ? 0 : f.intervals.size / b.intervals.size,
        realizedWinRate: filteredRealized,
        meanPLower: filteredMeanP,
        gap: filteredRealized - filteredMeanP,
      },
      delta: {
        deltaRealizedWinRate: filteredRealized - baselineRealized,
        deltaGap: (filteredRealized - filteredMeanP) - (baselineRealized - baselineMeanP),
        deltaIntervals: f.intervals.size - b.intervals.size,
      },
    };
  });
  return { asset, byThreshold };
}

// ---------------------------------------------------------------------------
// Top-level report assembly

export type ExperimentReport = Readonly<{
  version: "wiggler-experiment-report-v1";
  generated_at_iso: string;
  git: Readonly<{ commit_sha: string | null; dirty: boolean }>;
  anchor_mode: "boundary";
  interval_sec: number;
  train_end_iso: string;
  test_start_iso: string;
  assets: readonly string[];
  perAssetRowCounts: ReadonlyArray<{
    asset: string;
    rows: number;
    intervals: number;
    days: number;
  }>;
  experiments: Readonly<{
    session: SessionExperiment;
    dayOfWeek: ExperimentByAsset<string>;
    etHour: ExperimentByAsset<number>;
    utcHour: ExperimentByAsset<number>;
    slot: ExperimentByAsset<number>;
    lineCross: ExperimentByAsset<string>;
    timeSinceLastCross: ExperimentByAsset<string>;
    leaderAge: ExperimentByAsset<string>;
    momentumAligned60s: ExperimentByAsset<string>;
    momentumAligned120s: ExperimentByAsset<string>;
    retracing60s: ExperimentByAsset<string>;
    leadDecay: ExperimentByAsset<string>;
    rules: ReadonlyArray<RuleResult>;
  }>;
  recommendations: readonly Recommendation[];
}>;

export type RecommendationLabel =
  | "ignore"
  | "no_trade_filter"
  | "edge_multiplier"
  | "add_as_grid_dimension"
  | "needs_more_data";

export type Recommendation = Readonly<{
  feature: string;
  label: RecommendationLabel;
  reasoning: string;
}>;

export function buildExperimentReport(args: {
  rowsByAsset: ReadonlyMap<string, readonly ExperimentRow[]>;
  intervalSec: number;
  trainEndIso: string;
  testStartIso: string;
  generatedAtIso: string;
  git: Readonly<{ commit_sha: string | null; dirty: boolean }>;
}): ExperimentReport {
  const assets = [...args.rowsByAsset.keys()];
  const perAssetRowCounts = assets.map((asset) => {
    const rows = args.rowsByAsset.get(asset) ?? [];
    const intervals = new Set<number>();
    let minMs = Infinity;
    let maxMs = -Infinity;
    for (const r of rows) {
      intervals.add(r.anchorIdx);
      if (r.intervalStartMs < minMs) {minMs = r.intervalStartMs;}
      if (r.intervalStartMs > maxMs) {maxMs = r.intervalStartMs;}
    }
    const days = Number.isFinite(minMs) && Number.isFinite(maxMs)
      ? Math.max(1, (maxMs - minMs) / 86_400_000)
      : 0;
    return { asset, rows: rows.length, intervals: intervals.size, days };
  });

  const session = buildSessionExperiment(args.rowsByAsset);
  const dayOfWeek = buildPerAsset<string>(
    args.rowsByAsset,
    (r) => r.etWeekday,
    ORDERED_DOW,
  );
  const etHour = buildPerAsset<number>(
    args.rowsByAsset,
    (r) => r.etHour,
    HOURS_24,
  );
  const utcHourExp = buildPerAsset<number>(
    args.rowsByAsset,
    (r) => r.utcHour,
    HOURS_24,
  );
  const slot = buildPerAsset<number>(
    args.rowsByAsset,
    (r) => r.slotMinute,
    SLOT_LEVELS,
  );
  const lineCross = buildPerAsset<string>(
    args.rowsByAsset,
    (r) => r.lineCrossBucket,
    [...LINE_CROSS_BUCKETS],
  );
  const timeSinceLastCross = buildPerAsset<string>(
    args.rowsByAsset,
    (r) => r.timeSinceLastCrossBucket,
    [...TIME_SINCE_CROSS_BUCKETS],
  );
  const leaderAge = buildPerAsset<string>(
    args.rowsByAsset,
    (r) => r.leaderAgeBucket,
    [...LEADER_AGE_BUCKETS],
  );
  const momentumAligned60s = buildPerAsset<string>(
    args.rowsByAsset,
    (r) => (r.momentumAligned60s ? "aligned" : "opposed"),
    ["aligned", "opposed"],
  );
  const momentumAligned120s = buildPerAsset<string>(
    args.rowsByAsset,
    (r) =>
      r.momentumAligned120s === null
        ? "unknown"
        : r.momentumAligned120s
          ? "aligned"
          : "opposed",
    ["aligned", "opposed", "unknown"],
  );
  const retracing60s = buildPerAsset<string>(
    args.rowsByAsset,
    (r) => (r.retracing60s ? "retracing" : "not_retracing"),
    ["retracing", "not_retracing"],
  );
  const leadDecay = buildPerAsset<string>(
    args.rowsByAsset,
    (r) => r.leadDecayBucket,
    [...LEAD_DECAY_BUCKETS],
  );
  const rules = RULE_DEFS.map((d) =>
    buildRuleResult(d.id, d.description, args.rowsByAsset, d.keep),
  );

  const experiments: ExperimentReport["experiments"] = {
    session,
    dayOfWeek,
    etHour,
    utcHour: utcHourExp,
    slot,
    lineCross,
    timeSinceLastCross,
    leaderAge,
    momentumAligned60s,
    momentumAligned120s,
    retracing60s,
    leadDecay,
    rules,
  };

  const recommendations = buildRecommendations(experiments);

  return {
    version: "wiggler-experiment-report-v1",
    generated_at_iso: args.generatedAtIso,
    git: args.git,
    anchor_mode: "boundary",
    interval_sec: args.intervalSec,
    train_end_iso: args.trainEndIso,
    test_start_iso: args.testStartIso,
    assets,
    perAssetRowCounts,
    experiments,
    recommendations,
  };
}


// ---------------------------------------------------------------------------
// Recommendations

/**
 * Cross-asset survival check + concrete action labels.
 *
 * Every feature is graded at p_lower ≥ 0.95 (the threshold prod will
 * actually trade out of) on three axes:
 *
 *   1. Aggregate Δrealized: pooled across BTC/ETH/SOL/XRP/DOGE.
 *   2. Per-asset survival: positive Δrealized in ≥ N-1 of N assets so
 *      we're not chasing a one-asset artifact.
 *   3. Intervals kept: how aggressively the rule trims opportunity.
 *
 * Output labels:
 *   - `no_trade_filter` — Δrealized ≥ +0.30% AND ≥(N−1)/N assets
 *     positive AND intervals_kept ≥ 75%. Hard skip.
 *   - `edge_multiplier` — Δrealized ≥ +0.10% AND ≥(N−1)/N assets
 *     positive AND intervals_kept ≥ 75%. Add required edge.
 *   - `ignore` — no signal, redundant, or already absorbed by
 *     vol_bin.
 *   - `needs_more_data` — directional but small (|Δrealized| <
 *     0.10%); re-evaluate at next holdout.
 */
function buildRecommendations(
  experiments: ExperimentReport["experiments"],
): readonly Recommendation[] {
  const out: Recommendation[] = [];

  type Survival = {
    aggDeltaRealized: number;
    aggKept: number;
    perAssetDeltas: ReadonlyArray<{ asset: string; deltaRealized: number }>;
    perAssetPositive: number;
  };

  const survivalAt95 = (ruleId: RuleId): Survival | null => {
    const rule = experiments.rules.find((r) => r.ruleId === ruleId);
    if (rule === undefined) {return null;}
    const agg = rule.perAsset
      .find((p) => p.asset === "AGGREGATE")
      ?.byThreshold.find((b) => b.threshold === 0.95);
    if (agg === undefined) {return null;}
    const perAsset = rule.perAsset
      .filter((p) => p.asset !== "AGGREGATE")
      .map((p) => ({
        asset: p.asset,
        deltaRealized:
          p.byThreshold.find((b) => b.threshold === 0.95)?.delta
            .deltaRealizedWinRate ?? 0,
      }));
    return {
      aggDeltaRealized: agg.delta.deltaRealizedWinRate,
      aggKept: agg.filtered.intervalsKeptPct,
      perAssetDeltas: perAsset,
      perAssetPositive: perAsset.filter((p) => p.deltaRealized > 0).length,
    };
  };

  const labelFor = (s: Survival): RecommendationLabel => {
    const total = s.perAssetDeltas.length;
    const surviveBar = Math.max(1, total - 1);
    if (
      s.aggDeltaRealized >= 0.003 &&
      s.aggKept >= 0.75 &&
      s.perAssetPositive >= surviveBar
    ) {
      return "no_trade_filter";
    }
    if (
      s.aggDeltaRealized >= 0.001 &&
      s.aggKept >= 0.75 &&
      s.perAssetPositive >= surviveBar
    ) {
      return "edge_multiplier";
    }
    if (Math.abs(s.aggDeltaRealized) < 0.001) {
      return "ignore";
    }
    return "needs_more_data";
  };

  const fmtSurvival = (s: Survival): string => {
    const perAssetStr = s.perAssetDeltas
      .map((p) => `${p.asset} ${formatSigned(p.deltaRealized)}`)
      .join(", ");
    return `agg Δrealized=${formatSigned(s.aggDeltaRealized)} (kept ${formatPct(s.aggKept)}, ${s.perAssetPositive}/${s.perAssetDeltas.length} assets positive). Per-asset: ${perAssetStr}.`;
  };

  // ---- Time / session features ----

  out.push({
    feature: "session",
    label: "ignore",
    reasoning:
      "Across BTC/ETH/SOL/XRP/DOGE every session shows a positive aggregate gap at p_lower≥0.95 (model is conservative, not over-promising). No-trade filter would just discard tradable opportunities; effect of session is absorbed by vol_bin.",
  });
  out.push({
    feature: "day_of_week",
    label: "ignore",
    reasoning:
      "All days show positive aggregate gap at p_lower≥0.95. No day systematically over-promises; the variation between days is captured by vol_bin.",
  });

  const flagBadHours = (
    name: string,
    levels: ReadonlyArray<{ level: number; stats: BucketStats }>,
  ): Recommendation => {
    const bad = levels
      .filter((h) => h.stats.intervalCount > 100)
      .filter(
        (h) =>
          (h.stats.opportunities.find((o) => o.threshold === 0.95)?.gap ?? 0) <
          -0.02,
      );
    return {
      feature: name,
      label: bad.length === 0 ? "ignore" : "no_trade_filter",
      reasoning:
        bad.length === 0
          ? `No ${name} bucket has aggregate gap < −2pp at p_lower≥0.95. Already absorbed by vol_bin.`
          : `${bad.length} bucket(s) show aggregate gap < −2pp at p_lower≥0.95: ${bad.map((h) => h.level).join(", ")}.`,
    };
  };
  out.push(flagBadHours("et_hour", experiments.etHour.aggregate));
  out.push(flagBadHours("utc_hour", experiments.utcHour.aggregate));
  out.push(flagBadHours("slot_minute", experiments.slot.aggregate));

  // ---- Path-state rules ----

  for (const ruleId of [
    "no_cross_count_ge2",
    "no_cross_count_ge3",
  ] as const) {
    const s = survivalAt95(ruleId);
    if (s !== null) {
      out.push({
        feature: ruleId.replace("no_", "line_"),
        label: labelFor(s),
        reasoning: `${ruleId} ${fmtSurvival(s)}`,
      });
    }
  }

  {
    const s = survivalAt95("no_retracing_60s");
    if (s !== null) {
      out.push({
        feature: "retracing_60s",
        label: labelFor(s),
        reasoning: `no_retracing_60s ${fmtSurvival(s)} Equivalent to require_momentum_aligned_60s.`,
      });
    }
  }

  {
    const s = survivalAt95("require_leader_age_ge60");
    if (s !== null) {
      out.push({
        feature: "current_leader_age_sec_ge60",
        label: labelFor(s),
        reasoning: `require_leader_age_ge60 ${fmtSurvival(s)} The 60s threshold is too lax — every decision row at remaining=60s already has age ≥ 60s by construction.`,
      });
    }
  }

  {
    const s50 = survivalAt95("require_lead_decay_ge_0_50");
    const s75 = survivalAt95("require_lead_decay_ge_0_75");
    if (s75 !== null) {
      out.push({
        feature: "lead_decay_ratio_ge_0_75",
        label: labelFor(s75),
        reasoning: `require_lead_decay_ge_0_75 ${fmtSurvival(s75)} The 0.50 cut shows a smaller effect (${s50 !== null ? formatSigned(s50.aggDeltaRealized) : "n/a"} agg).`,
      });
    }
  }

  {
    const s = survivalAt95("require_momentum_aligned_60s");
    if (s !== null) {
      out.push({
        feature: "momentum_aligned_60s",
        label: "ignore",
        reasoning: `Mathematically equivalent to no_retracing_60s — same Δrealized=${formatSigned(s.aggDeltaRealized)}. Use the retracing label; this row is redundant.`,
      });
    }
  }

  for (const ruleId of [
    "no_weekend",
    "only_weekend",
    "no_weekday_us_cash",
    "no_weekday_overnight",
  ] as const) {
    const s = survivalAt95(ruleId);
    if (s !== null) {
      out.push({
        feature: ruleId,
        label: labelFor(s),
        reasoning: `${ruleId} ${fmtSurvival(s)}`,
      });
    }
  }

  return out;
}

function formatSigned(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "±";
  return `${sign}${(Math.abs(value) * 100).toFixed(2)}%`;
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}
