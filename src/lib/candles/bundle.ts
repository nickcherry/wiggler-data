import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Timeframe } from "@wiggler/constants/candles";
import {
  buildCalibrationReport,
  type CalibrationReport,
} from "@wiggler/lib/candles/calibrationReport";
import {
  type AssetEligibility,
  getEligibility,
  LIVE_INELIGIBILITY_REASONS,
} from "@wiggler/lib/candles/eligibility";
import type { LookaheadSource } from "@wiggler/lib/candles/lookahead";
import {
  buildOpportunityReport,
  type OpportunityReport,
} from "@wiggler/lib/candles/opportunityReport";
import { loadClosePoints } from "@wiggler/lib/candles/queries";
import {
  buildTieAndAnchorDiagnostics,
  loadSourceCompositionByMonth,
  type TrainingDiagnostics,
} from "@wiggler/lib/candles/trainingDiagnostics";
import { buildWinProbGrid } from "@wiggler/lib/candles/winProbGrid";
import {
  buildWigglerProbGridConfig,
  computeInputHash,
  type RiskAndFeeDefaults,
  type WigglerProbGridConfig,
} from "@wiggler/lib/candles/winProbGridConfig";
import type { DatabaseClient } from "@wiggler/lib/db/types";

/**
 * The handoff bundle wiggler-prod consumes. Per asset, two sibling
 * JSON files (the config + the validation artifact) plus a top-level
 * manifest that lists everything, names the regen commands, and
 * spells out which configs are paper-eligible vs quarantined and why
 * none are live-eligible yet.
 *
 * Layout:
 *
 *   tmp/bundle/
 *     manifest.json
 *     manifest.md
 *     <ASSET>_<INTERVAL>s_<MODE>.config.json
 *     <ASSET>_<INTERVAL>s_<MODE>.validation.json
 *     ...
 *
 * Everything is generated — re-running `bun wiggler candles:bundle`
 * overwrites the directory.
 */

export const BUNDLE_DIR = "tmp/bundle";

export type ValidationArtifact = Readonly<{
  asset: string;
  interval_sec: number;
  anchor_mode: "boundary" | "rolling";
  generated_at_iso: string;
  /** SHA-256 of the canonical bucket array — same value as the
   *  config's `config_hash`. Lets a consumer pair a validation file
   *  with its config without trusting the filename. */
  config_hash: string;
  diagnostics: TrainingDiagnostics;
  in_sample_calibration: CalibrationReport;
  /** Out-of-sample: train on prefix, validate on suffix. The bundle
   *  command runs this with a 9/3 month split. */
  out_of_sample_calibration: CalibrationReport | null;
  out_of_sample_window: Readonly<{
    train_end_iso: string;
    test_start_iso: string;
  }> | null;
  opportunity: OpportunityReport;
}>;

export type BundleEntry = Readonly<{
  asset: string;
  interval_sec: number;
  anchor_mode: "boundary" | "rolling";
  config_path: string;
  validation_path: string;
  config_hash: string;
  eligibility: AssetEligibility;
}>;

export type BundleManifest = Readonly<{
  version: "wiggler-data-bundle-v1";
  generated_at_iso: string;
  git: Readonly<{ commit_sha: string | null; dirty: boolean }>;
  /** Where this bundle was written, relative to the repo root. */
  bundle_dir: string;
  summary: Readonly<{
    total_assets: number;
    paper_eligible: number;
    live_eligible: number;
    quarantined: number;
  }>;
  entries: readonly BundleEntry[];
  live_ineligibility_reasons: readonly string[];
  regenerate_commands: readonly string[];
}>;

/**
 * Builds the per-asset config + validation pair. Pure: no I/O. Caller
 * supplies the closes (so source composition + input-hash stay in
 * sync with the actual grid input).
 */
export async function buildAssetBundle(args: {
  db: DatabaseClient;
  asset: string;
  timeframe: Timeframe;
  intervalSec: number;
  anchorStepMin: number;
  labelSource: LookaheadSource;
  volLookbackMin: number;
  /** Out-of-sample split. Train on `[-∞, trainEndMs]`, validate on
   *  `[testStartMs, ∞]`. When omitted, OOS calibration is skipped. */
  oosSplitMs?: Readonly<{ trainEndMs: number; testStartMs: number }>;
  riskDefaults?: Partial<RiskAndFeeDefaults>;
  generatedAtIso?: string;
  git?: Readonly<{ commit_sha: string | null; dirty: boolean }>;
}): Promise<{
  config: WigglerProbGridConfig;
  validation: ValidationArtifact;
}> {
  const closes = await loadClosePoints(args.db, {
    source: args.labelSource,
    symbol: args.asset,
    timeframe: args.timeframe,
  });
  if (closes.length === 0) {
    throw new Error(
      `no closes for (source=${args.labelSource}, asset=${args.asset}, timeframe=${args.timeframe})`,
    );
  }

  const eligibility =
    getEligibility(args.asset) ?? {
      asset: args.asset.toUpperCase(),
      quarantine: false,
      quarantine_reasons: [],
      eligible_for_research: true,
      eligible_for_paper: false,
      eligible_for_live: false,
    };

  const grid = buildWinProbGrid({
    closes,
    intervalSec: args.intervalSec,
    anchorStepMin: args.anchorStepMin,
    volLookbackMin: args.volLookbackMin,
  });
  const inputHash = computeInputHash(closes);
  const config = buildWigglerProbGridConfig({
    grid,
    asset: args.asset,
    trainingLabelSource: args.labelSource,
    volLookbackMin: args.volLookbackMin,
    inputHash,
    eligibility,
    riskDefaults: args.riskDefaults,
    generatedAtIso: args.generatedAtIso,
    git: args.git,
  });

  // Diagnostics: anchor balance + ties (full-window) + per-month
  // source composition.
  const tieAndAnchor = buildTieAndAnchorDiagnostics({
    closes,
    intervalSec: args.intervalSec,
    anchorStepMin: args.anchorStepMin,
    volLookbackMin: args.volLookbackMin,
  });
  const sourceComposition = await loadSourceCompositionByMonth(args.db, {
    symbol: args.asset,
    timeframe: args.timeframe,
  });
  const totalAnchors = tieAndAnchor.upAnchors + tieAndAnchor.downAnchors;
  const diagnostics: TrainingDiagnostics = {
    asset: args.asset.toUpperCase(),
    timeframe: args.timeframe,
    intervalSec: args.intervalSec,
    windowStartIso:
      closes.length > 0 ? new Date(closes[0]!.tsMs).toISOString() : null,
    windowEndIso:
      closes.length > 0
        ? new Date(closes[closes.length - 1]!.tsMs).toISOString()
        : null,
    upAnchors: tieAndAnchor.upAnchors,
    downAnchors: tieAndAnchor.downAnchors,
    upShareAll: totalAnchors === 0 ? 0 : tieAndAnchor.upAnchors / totalAnchors,
    ties: tieAndAnchor.ties,
    anchorBalanceByMonth: tieAndAnchor.anchorBalanceByMonth,
    sourceCompositionByMonth: sourceComposition,
  };

  // In-sample calibration (sanity check: bucket math is internally
  // consistent).
  const inSampleCalibration = buildCalibrationReport({
    config,
    closes,
    volLookbackMin: args.volLookbackMin,
  });

  // Out-of-sample calibration: train a separate grid on the prefix,
  // validate on the suffix using the prefix-trained lookup.
  let outOfSampleCalibration: CalibrationReport | null = null;
  let oosWindow: ValidationArtifact["out_of_sample_window"] = null;
  if (args.oosSplitMs !== undefined) {
    const trainGrid = buildWinProbGrid({
      closes,
      intervalSec: args.intervalSec,
      anchorStepMin: args.anchorStepMin,
      volLookbackMin: args.volLookbackMin,
      trainEndMs: args.oosSplitMs.trainEndMs,
    });
    const trainConfig = buildWigglerProbGridConfig({
      grid: trainGrid,
      asset: args.asset,
      trainingLabelSource: args.labelSource,
      volLookbackMin: args.volLookbackMin,
      inputHash,
      eligibility,
      riskDefaults: args.riskDefaults,
      generatedAtIso: args.generatedAtIso,
      git: args.git,
    });
    outOfSampleCalibration = buildCalibrationReport({
      config: trainConfig,
      closes,
      volLookbackMin: args.volLookbackMin,
      testStartMs: args.oosSplitMs.testStartMs,
    });
    oosWindow = {
      train_end_iso: new Date(args.oosSplitMs.trainEndMs).toISOString(),
      test_start_iso: new Date(args.oosSplitMs.testStartMs).toISOString(),
    };
  }

  // Opportunity (interval-level + bucket-level signal counts).
  const opportunity = buildOpportunityReport({
    config,
    closes,
    volLookbackMin: args.volLookbackMin,
  });

  const validation: ValidationArtifact = {
    asset: args.asset.toUpperCase(),
    interval_sec: args.intervalSec,
    anchor_mode: config.anchor_mode,
    generated_at_iso: config.generated_at_iso,
    config_hash: config.config_hash,
    diagnostics,
    in_sample_calibration: inSampleCalibration,
    out_of_sample_calibration: outOfSampleCalibration,
    out_of_sample_window: oosWindow,
    opportunity,
  };

  return { config, validation };
}

export function bundleConfigPath(args: {
  asset: string;
  intervalSec: number;
  anchorMode: "boundary" | "rolling";
  bundleDir?: string;
}): string {
  return join(
    args.bundleDir ?? BUNDLE_DIR,
    `${args.asset.toUpperCase()}_${args.intervalSec}s_${args.anchorMode}.config.json`,
  );
}

export function bundleValidationPath(args: {
  asset: string;
  intervalSec: number;
  anchorMode: "boundary" | "rolling";
  bundleDir?: string;
}): string {
  return join(
    args.bundleDir ?? BUNDLE_DIR,
    `${args.asset.toUpperCase()}_${args.intervalSec}s_${args.anchorMode}.validation.json`,
  );
}

export async function writeBundleFile(
  path: string,
  body: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(body, null, 2));
}

/**
 * Compose the top-level manifest from the per-asset entries. Pure: no
 * I/O.
 */
export function buildManifest(args: {
  bundleDir: string;
  generatedAtIso: string;
  git: Readonly<{ commit_sha: string | null; dirty: boolean }>;
  entries: readonly BundleEntry[];
  regenerateCommands: readonly string[];
}): BundleManifest {
  const paperEligible = args.entries.filter(
    (e) => e.eligibility.eligible_for_paper,
  ).length;
  const liveEligible = args.entries.filter(
    (e) => e.eligibility.eligible_for_live,
  ).length;
  const quarantined = args.entries.filter((e) => e.eligibility.quarantine).length;
  return {
    version: "wiggler-data-bundle-v1",
    generated_at_iso: args.generatedAtIso,
    git: args.git,
    bundle_dir: args.bundleDir,
    summary: {
      total_assets: args.entries.length,
      paper_eligible: paperEligible,
      live_eligible: liveEligible,
      quarantined,
    },
    entries: args.entries,
    live_ineligibility_reasons: LIVE_INELIGIBILITY_REASONS,
    regenerate_commands: args.regenerateCommands,
  };
}

/**
 * Render the manifest as a human-readable markdown file. Mirrors the
 * JSON manifest 1:1 — same data, friendlier formatting. Wiggler-prod
 * reads the JSON; humans read the MD.
 */
export function renderManifestMarkdown(manifest: BundleManifest): string {
  const lines: string[] = [];
  lines.push(`# wiggler-data bundle (${manifest.version})`);
  lines.push("");
  lines.push(`Generated: ${manifest.generated_at_iso}`);
  lines.push(
    `Git: ${manifest.git.commit_sha ?? "unknown"}${manifest.git.dirty ? " (dirty worktree)" : ""}`,
  );
  lines.push(`Bundle dir: \`${manifest.bundle_dir}\``);
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(`- Total assets: ${manifest.summary.total_assets}`);
  lines.push(`- Paper-eligible: ${manifest.summary.paper_eligible}`);
  lines.push(`- Live-eligible: ${manifest.summary.live_eligible}`);
  lines.push(`- Quarantined: ${manifest.summary.quarantined}`);
  lines.push("");
  lines.push(`## Entries`);
  lines.push("");
  lines.push(
    "| asset | interval | mode | paper | live | quarantine | config | validation |",
  );
  lines.push("|:--|--:|:--|:--:|:--:|:--:|:--|:--|");
  for (const e of manifest.entries) {
    const paper = e.eligibility.eligible_for_paper ? "✓" : "";
    const live = e.eligibility.eligible_for_live ? "✓" : "";
    const quarantine = e.eligibility.quarantine ? "⚠" : "";
    lines.push(
      `| ${e.asset} | ${e.interval_sec}s | ${e.anchor_mode} | ${paper} | ${live} | ${quarantine} | \`${e.config_path}\` | \`${e.validation_path}\` |`,
    );
  }
  lines.push("");
  const quarantined = manifest.entries.filter((e) => e.eligibility.quarantine);
  if (quarantined.length > 0) {
    lines.push(`## Quarantine reasons`);
    lines.push("");
    for (const e of quarantined) {
      lines.push(`### ${e.asset}`);
      lines.push("");
      for (const reason of e.eligibility.quarantine_reasons) {
        lines.push(`- ${reason}`);
      }
      lines.push("");
    }
  }
  lines.push(`## Why no asset is live-eligible yet`);
  lines.push("");
  for (const reason of manifest.live_ineligibility_reasons) {
    lines.push(`- ${reason}`);
  }
  lines.push("");
  lines.push(`## Regenerate the bundle`);
  lines.push("");
  lines.push("```bash");
  for (const cmd of manifest.regenerate_commands) {
    lines.push(cmd);
  }
  lines.push("```");
  lines.push("");
  return lines.join("\n") + "\n";
}
