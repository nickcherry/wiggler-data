import type {
  BucketStats,
  ExperimentByAsset,
  ExperimentReport,
  RuleResult,
} from "@wiggler/lib/candles/experimentReport";

/**
 * Renders the structured experiment report as a markdown document
 * suitable for human review or pasting into a chat. Tables are kept
 * compact: high-confidence opportunity stats are surfaced first;
 * full p_lower-bin calibration is included for the non-trivial
 * dimensions only (session, line cross, retracing, lead decay).
 *
 * Mirrors the JSON 1:1 — same data, friendlier shape.
 */

export function renderExperimentMarkdown(report: ExperimentReport): string {
  const lines: string[] = [];
  lines.push(`# Wiggler experiment report (OOS only)`);
  lines.push("");
  lines.push(`Generated: ${report.generated_at_iso}`);
  lines.push(
    `Git: ${report.git.commit_sha ?? "unknown"}${report.git.dirty ? " (dirty worktree)" : ""}`,
  );
  lines.push(
    `Window: train_end ≤ ${report.train_end_iso} (training); test ≥ ${report.test_start_iso} (calibration); anchor_mode=${report.anchor_mode}; interval_sec=${report.interval_sec}`,
  );
  lines.push("");
  lines.push(`## Per-asset OOS sample size`);
  lines.push("");
  lines.push("| asset | rows | intervals | days |");
  lines.push("|:--|--:|--:|--:|");
  for (const r of report.perAssetRowCounts) {
    lines.push(
      `| ${r.asset} | ${fmtCount(r.rows)} | ${fmtCount(r.intervals)} | ${r.days.toFixed(1)} |`,
    );
  }
  lines.push("");

  lines.push(`## Recommendations`);
  lines.push("");
  lines.push(`Each feature is scored against the existing baseline grid using cross-asset (aggregate) deltas at p_lower≥0.95. \`needs_more_data\` means OOS sample is too small or effect too noisy. \`ignore\` means the feature is redundant with vol_bin or didn't survive the rubric. \`no_trade_filter\` / \`edge_multiplier\` / \`add_as_grid_dimension\` mean the feature looks worth wiring into prod under that role.`);
  lines.push("");
  lines.push("| feature | label | reasoning |");
  lines.push("|:--|:--|:--|");
  for (const rec of report.recommendations) {
    lines.push(`| ${rec.feature} | ${rec.label} | ${rec.reasoning} |`);
  }
  lines.push("");

  // Experiment 1: session + session × vol
  lines.push(`## Experiment 1 — Session (America/New_York)`);
  lines.push("");
  lines.push(`### Per-asset session breakdown`);
  lines.push("");
  appendByAssetTable(lines, report.experiments.session.byAsset, (s) => s);
  lines.push("");
  lines.push(`### Aggregate session × vol_bin calibration (p_lower bins)`);
  lines.push("");
  lines.push(
    "| asset | session | vol_bin | bin | count | realized | mean p_lower | gap |",
  );
  lines.push("|:--|:--|:--|:--|--:|--:|--:|--:|");
  for (const sv of report.experiments.session.sessionByVol) {
    for (const bin of sv.bins) {
      if (bin.count < 50) {continue;}
      lines.push(
        `| ${sv.asset} | ${sv.session} | ${sv.volBin} | ${binLabel(bin.pWinLowerMin, bin.pWinLowerMax)} | ${fmtCount(bin.count)} | ${fmtPct(bin.realizedWinRate)} | ${fmtPct(bin.meanPredicted)} | ${fmtSigned(bin.gap)} |`,
      );
    }
  }
  lines.push("");

  // Experiment 2
  lines.push(`## Experiment 2 — Day of week (ET)`);
  lines.push("");
  appendByAssetTable(lines, report.experiments.dayOfWeek, (s) => s);
  lines.push("");

  // Experiment 3
  lines.push(`## Experiment 3 — Hour of day`);
  lines.push("");
  lines.push(`### ET hour`);
  lines.push("");
  appendByAssetTable(lines, report.experiments.etHour, (n) =>
    String(n).padStart(2, "0"),
  );
  lines.push("");
  lines.push(`### UTC hour`);
  lines.push("");
  appendByAssetTable(lines, report.experiments.utcHour, (n) =>
    String(n).padStart(2, "0"),
  );
  lines.push("");

  // Experiment 4
  lines.push(`## Experiment 4 — 5-minute boundary slot (UTC minute-of-hour)`);
  lines.push("");
  appendByAssetTable(lines, report.experiments.slot, (n) =>
    `:${String(n).padStart(2, "0")}`,
  );
  lines.push("");

  // Experiment 5
  lines.push(`## Experiment 5 — Line-cross / chop state`);
  lines.push("");
  lines.push(`### line_cross_count`);
  lines.push("");
  appendByAssetTable(lines, report.experiments.lineCross, (s) => s);
  lines.push("");
  lines.push(`### time_since_last_cross`);
  lines.push("");
  appendByAssetTable(lines, report.experiments.timeSinceLastCross, (s) => s);
  lines.push("");
  lines.push(`### current_leader_age_sec`);
  lines.push("");
  appendByAssetTable(lines, report.experiments.leaderAge, (s) => s);
  lines.push("");

  // Experiment 6
  lines.push(`## Experiment 6 — Recent momentum / retrace`);
  lines.push("");
  lines.push(`### momentum_aligned_60s`);
  lines.push("");
  appendByAssetTable(lines, report.experiments.momentumAligned60s, (s) => s);
  lines.push("");
  lines.push(`### momentum_aligned_120s`);
  lines.push("");
  appendByAssetTable(lines, report.experiments.momentumAligned120s, (s) => s);
  lines.push("");
  lines.push(`### retracing_60s`);
  lines.push("");
  appendByAssetTable(lines, report.experiments.retracing60s, (s) => s);
  lines.push("");

  // Experiment 7
  lines.push(`## Experiment 7 — Path quality / lead decay`);
  lines.push("");
  appendByAssetTable(lines, report.experiments.leadDecay, (s) => s);
  lines.push("");

  // Experiment 8
  lines.push(`## Experiment 8 — Candidate rule overlays (OOS)`);
  lines.push("");
  for (const rule of report.experiments.rules) {
    appendRuleTable(lines, rule);
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

function appendByAssetTable<L extends string | number>(
  lines: string[],
  exp: ExperimentByAsset<L>,
  fmtLevel: (l: L) => string,
): void {
  // One section per asset + aggregate.
  for (const a of exp.perAsset) {
    lines.push(`#### ${a.asset}`);
    lines.push("");
    lines.push(
      "| level | rows | intervals | up_share | mean p_lower | realized | gap | max_abs_calib_gap | p≥0.90 ints | p≥0.95 ints | p≥0.98 ints |",
    );
    lines.push("|:--|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
    for (const lvl of a.byLevel) {
      const s = lvl.stats;
      lines.push(
        `| ${fmtLevel(lvl.level)} | ${fmtCount(s.rowCount)} | ${fmtCount(s.intervalCount)} | ${fmtPct(s.upShare)} | ${fmtPct(s.meanPLower)} | ${fmtPct(s.realizedWinRate)} | ${fmtSigned(s.gapAll)} | ${fmtPct(s.maxAbsCalibrationGap)} | ${fmtCount(opp(s, 0.9).intervalsSignaling)} | ${fmtCount(opp(s, 0.95).intervalsSignaling)} | ${fmtCount(opp(s, 0.98).intervalsSignaling)} |`,
      );
    }
    lines.push("");
  }
  lines.push(`#### AGGREGATE (BTC + ETH + SOL + XRP + DOGE)`);
  lines.push("");
  lines.push(
    "| level | rows | intervals | up_share | mean p_lower | realized | gap | max_abs_calib_gap | p≥0.90 ints | p≥0.95 ints | p≥0.98 ints | p≥0.95 realized | p≥0.95 gap |",
  );
  lines.push("|:--|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
  for (const lvl of exp.aggregate) {
    const s = lvl.stats;
    const o95 = opp(s, 0.95);
    lines.push(
      `| ${fmtLevel(lvl.level)} | ${fmtCount(s.rowCount)} | ${fmtCount(s.intervalCount)} | ${fmtPct(s.upShare)} | ${fmtPct(s.meanPLower)} | ${fmtPct(s.realizedWinRate)} | ${fmtSigned(s.gapAll)} | ${fmtPct(s.maxAbsCalibrationGap)} | ${fmtCount(opp(s, 0.9).intervalsSignaling)} | ${fmtCount(o95.intervalsSignaling)} | ${fmtCount(opp(s, 0.98).intervalsSignaling)} | ${fmtPct(o95.realizedWinRate)} | ${fmtSigned(o95.gap)} |`,
    );
  }
}

function appendRuleTable(lines: string[], rule: RuleResult): void {
  lines.push(`### ${rule.ruleId} — ${rule.description}`);
  lines.push("");
  lines.push(
    "| asset | threshold | base int | filt int | kept | base realized | filt realized | Δ realized | base gap | filt gap | Δ gap |",
  );
  lines.push("|:--|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
  for (const a of rule.perAsset) {
    for (const t of a.byThreshold) {
      lines.push(
        `| ${a.asset} | ${t.threshold.toFixed(2)} | ${fmtCount(t.baseline.intervalsSignaling)} | ${fmtCount(t.filtered.intervalsSignaling)} | ${fmtPct(t.filtered.intervalsKeptPct)} | ${fmtPct(t.baseline.realizedWinRate)} | ${fmtPct(t.filtered.realizedWinRate)} | ${fmtSigned(t.delta.deltaRealizedWinRate)} | ${fmtSigned(t.baseline.gap)} | ${fmtSigned(t.filtered.gap)} | ${fmtSigned(t.delta.deltaGap)} |`,
      );
    }
  }
}

function opp(s: BucketStats, threshold: number) {
  return (
    s.opportunities.find((o) => o.threshold === threshold) ?? {
      rowsAbove: 0,
      intervalsSignaling: 0,
      meanPredicted: 0,
      realizedWinRate: 0,
      gap: 0,
      threshold,
    }
  );
}

function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function fmtSigned(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : " ";
  return `${sign}${(Math.abs(value) * 100).toFixed(2)}%`;
}

function binLabel(lo: number, hi: number): string {
  return `[${lo.toFixed(2)}, ${hi.toFixed(2)})`;
}
