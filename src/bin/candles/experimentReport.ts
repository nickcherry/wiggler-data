import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type Timeframe, TIMEFRAMES } from "@wiggler/constants/candles";
import { getEligibility } from "@wiggler/lib/candles/eligibility";
import {
  buildExperimentReport,
  type ExperimentReport,
} from "@wiggler/lib/candles/experimentReport";
import { renderExperimentMarkdown } from "@wiggler/lib/candles/experimentReportMarkdown";
import {
  buildOosExperimentRows,
  type ExperimentRow,
} from "@wiggler/lib/candles/experimentRows";
import {
  LOOKAHEAD_SOURCES,
  type LookaheadSource,
} from "@wiggler/lib/candles/lookahead";
import { loadClosePoints } from "@wiggler/lib/candles/queries";
import {
  buildWinProbGrid,
  type ClosePoint,
} from "@wiggler/lib/candles/winProbGrid";
import {
  buildWigglerProbGridConfig,
  computeInputHash,
  readGitProvenance,
} from "@wiggler/lib/candles/winProbGridConfig";
import { defineCommand, defineValueOption } from "@wiggler/lib/cli";
import { CliUsageError } from "@wiggler/lib/cli/parser";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { z } from "zod";

const DEFAULT_OUT_DIR = "tmp/experiment-report";

/**
 * Decides whether time/session/path-state features add residual signal
 * beyond the existing baseline grid. Trains the baseline on the
 * prefix (anchors `open_time ≤ --train-end-iso`) and evaluates every
 * experiment OOS on the suffix.
 *
 * Output: `tmp/experiment-report/EXPERIMENT_REPORT.md` and
 * `tmp/experiment-report/experiment_report.json`. The .md is
 * human-friendly tables; the .json carries the full structured data.
 *
 * Does NOT touch the production bundle. Does NOT add new data
 * sources. Does NOT mutate the baseline grid — every experiment
 * compares against the existing
 * `(asset, remaining_sec, vol_bin, side_leading, abs_d_bps)` lookup.
 */
export const candlesExperimentReportCommand = defineCommand({
  name: "candles:experiment-report",
  summary:
    "OOS experiments evaluating residual signal from time / session / path-state features",
  description:
    "Trains the existing baseline win-probability grid on the prefix (anchors ≤ --train-end-iso) and evaluates eight experiments OOS on the suffix: session, day-of-week, ET-hour, UTC-hour, 5m boundary slot, line-cross/chop, momentum, lead-decay, and a set of candidate rule overlays. Writes a markdown summary plus a complete JSON artifact. Does not change or generate production runtime configs.",
  options: [
    defineValueOption({
      key: "anchorMode",
      long: "--anchor-mode",
      valueName: "MODE",
      schema: z.enum(["boundary"]).default("boundary"),
      description:
        "Boundary-aligned only — matches actual Polymarket fixed-window market cadence.",
    }),
    defineValueOption({
      key: "intervalSec",
      long: "--interval-sec",
      valueName: "SEC",
      schema: z.coerce.number().int().min(120).default(300),
    }),
    defineValueOption({
      key: "trainEndIso",
      long: "--train-end-iso",
      valueName: "ISO",
      schema: z.string().default("2026-01-30T00:00:00Z"),
    }),
    defineValueOption({
      key: "testStartIso",
      long: "--test-start-iso",
      valueName: "ISO",
      schema: z.string().optional(),
      description:
        "Defaults to --train-end-iso (no gap between train and test).",
    }),
    defineValueOption({
      key: "labelSource",
      long: "--label-source",
      valueName: "SOURCE",
      schema: z.string().default("vwap"),
    }),
    defineValueOption({
      key: "timeframe",
      long: "--timeframe",
      valueName: "TF",
      schema: z.enum(TIMEFRAMES).default("1m"),
    }),
    defineValueOption({
      key: "volLookbackMin",
      long: "--vol-lookback-min",
      valueName: "MIN",
      schema: z.coerce.number().int().min(5).default(30),
    }),
    defineValueOption({
      key: "assets",
      long: "--assets",
      valueName: "CSV",
      schema: z.string().default("BTC,ETH,SOL,XRP,DOGE"),
      description:
        "Comma-separated assets. HYPE/BNB are excluded by default — they are quarantined and would contaminate aggregate results.",
    }),
    defineValueOption({
      key: "outDir",
      long: "--out-dir",
      valueName: "PATH",
      schema: z.string().default(DEFAULT_OUT_DIR),
    }),
  ],
  examples: [
    "bun wiggler candles:experiment-report",
    "bun wiggler candles:experiment-report --assets BTC,ETH",
  ],
  output:
    "Writes EXPERIMENT_REPORT.md and experiment_report.json under --out-dir.",
  sideEffects:
    "Reads PostgreSQL. Writes two files under tmp/experiment-report/.",
  async run({ io, options }) {
    const intervalSec = options.intervalSec;
    if (intervalSec % 60 !== 0) {
      throw new CliUsageError(
        `--interval-sec must be a multiple of 60, got ${intervalSec}`,
      );
    }
    const intervalMin = intervalSec / 60;
    const labelSource = validateLabelSource(options.labelSource);
    const timeframe: Timeframe = options.timeframe;

    const trainEndMs = Date.parse(options.trainEndIso);
    if (!Number.isFinite(trainEndMs)) {
      throw new CliUsageError(
        `--train-end-iso: invalid ISO 8601 timestamp: ${options.trainEndIso}`,
      );
    }
    const testStartIso = options.testStartIso ?? options.trainEndIso;
    const testStartMs = Date.parse(testStartIso);
    if (!Number.isFinite(testStartMs)) {
      throw new CliUsageError(
        `--test-start-iso: invalid ISO 8601 timestamp: ${testStartIso}`,
      );
    }

    const assets = options.assets
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);
    if (assets.length === 0) {
      throw new CliUsageError("--assets cannot be empty");
    }
    // Defensive: warn if anyone tries to include HYPE/BNB.
    for (const a of assets) {
      const e = getEligibility(a);
      if (e?.quarantine === true) {
        io.writeStderr(
          `warning: ${a} is quarantined per v1 eligibility policy and is included only because the user explicitly listed it.\n`,
        );
      }
    }

    const outDir = options.outDir;
    await mkdir(outDir, { recursive: true });

    const generatedAtIso = new Date().toISOString();
    const git = readGitProvenance();
    const db = createDatabase();
    const rowsByAsset = new Map<string, readonly ExperimentRow[]>();

    try {
      for (const asset of assets) {
        io.writeStderr(`loading ${asset}…\n`);
        const closes = await loadClosePoints(db, {
          source: labelSource,
          symbol: asset,
          timeframe,
        });
        if (closes.length === 0) {
          io.writeStderr(
            `  skipping ${asset}: no closes for (source=${labelSource}, timeframe=${timeframe}).\n`,
          );
          continue;
        }
        const rows = collectAssetOosRows({
          asset,
          closes,
          intervalSec,
          intervalMin,
          labelSource,
          volLookbackMin: options.volLookbackMin,
          trainEndMs,
          testStartMs,
          generatedAtIso,
          git,
        });
        io.writeStderr(`  → ${asset}: ${rows.length.toLocaleString("en-US")} OOS decision rows\n`);
        rowsByAsset.set(asset, rows);
      }
    } finally {
      await destroyDatabase(db);
    }

    const report: ExperimentReport = buildExperimentReport({
      rowsByAsset,
      intervalSec,
      trainEndIso: options.trainEndIso,
      testStartIso,
      generatedAtIso,
      git,
    });
    const jsonPath = join(outDir, "experiment_report.json");
    const mdPath = join(outDir, "EXPERIMENT_REPORT.md");
    await writeFile(jsonPath, JSON.stringify(report, null, 2));
    await writeFile(mdPath, renderExperimentMarkdown(report));
    io.writeStdout(formatSummary({ report, jsonPath, mdPath }));
  },
});

function validateLabelSource(value: string): LookaheadSource {
  const allowed = new Set<string>(LOOKAHEAD_SOURCES);
  if (!allowed.has(value)) {
    throw new CliUsageError(
      `unknown --label-source: ${value}. Supported: ${LOOKAHEAD_SOURCES.join(", ")}.`,
    );
  }
  return value as LookaheadSource;
}

function collectAssetOosRows(args: {
  asset: string;
  closes: readonly ClosePoint[];
  intervalSec: number;
  intervalMin: number;
  labelSource: LookaheadSource;
  volLookbackMin: number;
  trainEndMs: number;
  testStartMs: number;
  generatedAtIso: string;
  git: Readonly<{ commit_sha: string | null; dirty: boolean }>;
}): readonly ExperimentRow[] {
  // Train baseline grid on the prefix only.
  const trainGrid = buildWinProbGrid({
    closes: args.closes,
    intervalSec: args.intervalSec,
    anchorStepMin: args.intervalMin, // boundary mode
    volLookbackMin: args.volLookbackMin,
    trainEndMs: args.trainEndMs,
  });
  const eligibility = getEligibility(args.asset) ?? {
    asset: args.asset.toUpperCase(),
    quarantine: false,
    quarantine_reasons: [],
    eligible_for_research: true,
    eligible_for_paper: false,
    eligible_for_live: false,
  };
  const baselineConfig = buildWigglerProbGridConfig({
    grid: trainGrid,
    asset: args.asset,
    trainingLabelSource: args.labelSource,
    volLookbackMin: args.volLookbackMin,
    inputHash: computeInputHash(args.closes),
    eligibility,
    generatedAtIso: args.generatedAtIso,
    git: args.git,
  });
  return buildOosExperimentRows({
    asset: args.asset,
    closes: args.closes,
    baselineConfig,
    volLookbackMin: args.volLookbackMin,
    testStartMs: args.testStartMs,
    anchorStepMin: args.intervalMin,
  });
}

function formatSummary(args: {
  report: ExperimentReport;
  jsonPath: string;
  mdPath: string;
}): string {
  const lines: string[] = [];
  lines.push(`experiment report:`);
  lines.push(`  md:   ${args.mdPath}`);
  lines.push(`  json: ${args.jsonPath}`);
  lines.push(`  generated: ${args.report.generated_at_iso}`);
  lines.push(
    `  window: train ≤ ${args.report.train_end_iso} / test ≥ ${args.report.test_start_iso}`,
  );
  lines.push("");
  lines.push(`per-asset OOS rows:`);
  for (const r of args.report.perAssetRowCounts) {
    lines.push(
      `  ${r.asset.padEnd(5)} ${r.rows.toLocaleString("en-US").padStart(10)} rows / ${r.intervals.toLocaleString("en-US").padStart(8)} intervals / ${r.days.toFixed(1).padStart(6)} days`,
    );
  }
  lines.push("");
  lines.push(`recommendations (${args.report.recommendations.length}):`);
  for (const rec of args.report.recommendations) {
    lines.push(`  ${rec.feature.padEnd(28)} → ${rec.label}`);
  }
  return `${lines.join("\n")}\n`;
}
