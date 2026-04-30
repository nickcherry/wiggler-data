import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type Timeframe, TIMEFRAMES } from "@wiggler/constants/candles";
import {
  buildAssetBundle,
  buildManifest,
  BUNDLE_DIR,
  bundleConfigPath,
  type BundleEntry,
  bundleValidationPath,
  renderManifestMarkdown,
  writeBundleFile,
} from "@wiggler/lib/candles/bundle";
import { BUNDLE_ASSETS, getEligibility } from "@wiggler/lib/candles/eligibility";
import {
  LOOKAHEAD_SOURCES,
  type LookaheadSource,
} from "@wiggler/lib/candles/lookahead";
import { readGitProvenance } from "@wiggler/lib/candles/winProbGridConfig";
import { defineCommand, defineFlagOption, defineValueOption } from "@wiggler/lib/cli";
import { CliUsageError } from "@wiggler/lib/cli/parser";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { z } from "zod";

/**
 * Emit the wiggler-data → wiggler-prod handoff bundle: one config
 * JSON + one validation JSON per asset, plus a top-level manifest in
 * both JSON and markdown.
 *
 * Boundary-mode only by default — that's the regime that matches
 * actual Polymarket fixed-window market boundaries, and the regime
 * to trust when rolling and boundary disagree on high-confidence
 * cells.
 *
 * The 9/3 OOS holdout split is the validation gate. Wiggler-prod
 * inspects each validation file's `out_of_sample_calibration` to
 * decide whether the cell-level lower bounds held up out-of-sample.
 */
export const candlesBundleCommand = defineCommand({
  name: "candles:bundle",
  summary:
    "Emit the wiggler-prod handoff bundle: per-asset config + validation + manifest",
  description:
    "Generates the wiggler-prob-grid-v1 config and validation artifact for every asset covered by the v1 eligibility policy (BTC/ETH/SOL/XRP/DOGE paper-eligible, HYPE/BNB quarantined, nothing live-eligible yet). Each asset gets two sibling JSONs in `tmp/bundle/`. A top-level `manifest.json` and `manifest.md` index everything, name the regen commands, and spell out why no asset is live-eligible. Boundary mode only: --anchor-step-min 5. OOS holdout: train ≤ --train-end-iso, validate ≥ --train-end-iso.",
  options: [
    defineValueOption({
      key: "timeframe",
      long: "--timeframe",
      valueName: "TF",
      schema: z.enum(TIMEFRAMES).default("1m"),
    }),
    defineValueOption({
      key: "labelSource",
      long: "--label-source",
      valueName: "SOURCE",
      schema: z.string().default("vwap"),
      description: `Training-label source. Supported: ${LOOKAHEAD_SOURCES.join(", ")}. Default: vwap (the cross-source aggregate, used as a Chainlink proxy).`,
    }),
    defineValueOption({
      key: "intervalSec",
      long: "--interval-sec",
      valueName: "SEC",
      schema: z.coerce.number().int().min(120).default(300),
    }),
    defineValueOption({
      key: "anchorStepMin",
      long: "--anchor-step-min",
      valueName: "MIN",
      schema: z.coerce.number().int().min(1).default(5),
      description:
        "Anchor stride. Default: 5 (boundary-aligned, matches Polymarket fixed-window cadence).",
    }),
    defineValueOption({
      key: "volLookbackMin",
      long: "--vol-lookback-min",
      valueName: "MIN",
      schema: z.coerce.number().int().min(5).default(30),
    }),
    defineValueOption({
      key: "trainEndIso",
      long: "--train-end-iso",
      valueName: "ISO",
      schema: z.string().default("2026-01-30T00:00:00Z"),
      description:
        "OOS split point. Train on anchors ≤ this, validate on anchors ≥ this.",
    }),
    defineValueOption({
      key: "bundleDir",
      long: "--bundle-dir",
      valueName: "PATH",
      schema: z.string().default(BUNDLE_DIR),
    }),
    defineValueOption({
      key: "assets",
      long: "--assets",
      valueName: "CSV",
      schema: z.string().optional(),
      description:
        "Override the asset list (comma-separated). Defaults to the v1 policy assets.",
    }),
    defineFlagOption({
      key: "skipQuarantined",
      long: "--skip-quarantined",
      schema: z.boolean().default(false),
      description:
        "Skip quarantined assets entirely instead of emitting their config (a quarantined config is research-only — paper/live false — but is included by default for transparency).",
    }),
  ],
  examples: [
    "bun wiggler candles:bundle",
    "bun wiggler candles:bundle --train-end-iso 2026-02-01T00:00:00Z",
    "bun wiggler candles:bundle --assets BTC,ETH",
    "bun wiggler candles:bundle --skip-quarantined  # exclude HYPE/BNB",
  ],
  output:
    "Writes `manifest.json`, `manifest.md`, and per-asset `<ASSET>_<INTERVAL>s_<MODE>.config.json` + `.validation.json` files to the bundle dir.",
  sideEffects:
    "Reads PostgreSQL. Writes files under `tmp/bundle/` (or --bundle-dir).",
  async run({ io, options }) {
    const timeframe: Timeframe = options.timeframe;
    const labelSource = validateLabelSource(options.labelSource);
    const intervalSec = options.intervalSec;
    if (intervalSec % 60 !== 0) {
      throw new CliUsageError(
        `--interval-sec must be a multiple of 60, got ${intervalSec}`,
      );
    }
    const intervalMin = intervalSec / 60;
    const anchorStepMin = options.anchorStepMin;
    if (anchorStepMin > intervalMin) {
      throw new CliUsageError(
        `--anchor-step-min (${anchorStepMin}) cannot exceed interval-min (${intervalMin})`,
      );
    }
    const trainEndMs = Date.parse(options.trainEndIso);
    if (!Number.isFinite(trainEndMs)) {
      throw new CliUsageError(
        `--train-end-iso: invalid ISO 8601 timestamp: ${options.trainEndIso}`,
      );
    }
    const bundleDir = options.bundleDir;

    const requestedAssets = options.assets
      ? splitCsv(options.assets).map((s) => s.toUpperCase())
      : [...BUNDLE_ASSETS];
    const filtered = options.skipQuarantined
      ? requestedAssets.filter((a) => {
          const e = getEligibility(a);
          return e === null ? true : !e.quarantine;
        })
      : requestedAssets;

    const generatedAtIso = new Date().toISOString();
    const git = readGitProvenance();
    const db = createDatabase();
    const entries: BundleEntry[] = [];

    try {
      for (const asset of filtered) {
        io.writeStderr(`generating ${asset}...\n`);
        const { config, validation } = await buildAssetBundle({
          db,
          asset,
          timeframe,
          intervalSec,
          anchorStepMin,
          labelSource,
          volLookbackMin: options.volLookbackMin,
          oosSplitMs: { trainEndMs, testStartMs: trainEndMs },
          generatedAtIso,
          git,
        });
        const configPath = bundleConfigPath({
          asset,
          intervalSec,
          anchorMode: config.anchor_mode,
          bundleDir,
        });
        const validationPath = bundleValidationPath({
          asset,
          intervalSec,
          anchorMode: config.anchor_mode,
          bundleDir,
        });
        await writeBundleFile(configPath, config);
        await writeBundleFile(validationPath, validation);
        entries.push({
          asset,
          interval_sec: intervalSec,
          anchor_mode: config.anchor_mode,
          config_path: configPath,
          validation_path: validationPath,
          config_hash: config.config_hash,
          eligibility: config.eligibility,
        });
      }
    } finally {
      await destroyDatabase(db);
    }

    const regenerateCommands = [
      "bun wiggler candles:sync",
      "bun wiggler candles:vwap",
      `bun wiggler candles:bundle --train-end-iso ${options.trainEndIso}`,
    ];
    const manifest = buildManifest({
      bundleDir,
      generatedAtIso,
      git,
      entries,
      regenerateCommands,
    });
    await mkdir(bundleDir, { recursive: true });
    await writeFile(
      join(bundleDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    await writeFile(join(bundleDir, "manifest.md"), renderManifestMarkdown(manifest));

    io.writeStdout(formatSummary({ manifest, bundleDir }));
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

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function formatSummary(args: {
  manifest: ReturnType<typeof buildManifest>;
  bundleDir: string;
}): string {
  const m = args.manifest;
  const lines: string[] = [];
  lines.push(`bundle:                 ${args.bundleDir}/`);
  lines.push(`generated:              ${m.generated_at_iso}`);
  lines.push(
    `git:                    ${m.git.commit_sha ?? "unknown"}${m.git.dirty ? " (dirty worktree)" : ""}`,
  );
  lines.push(
    `assets:                 ${m.summary.total_assets} total / ${m.summary.paper_eligible} paper / ${m.summary.live_eligible} live / ${m.summary.quarantined} quarantined`,
  );
  lines.push("");
  lines.push("entries:");
  for (const e of m.entries) {
    const paper = e.eligibility.eligible_for_paper ? "paper" : "—   ";
    const live = e.eligibility.eligible_for_live ? "live" : "—   ";
    const q = e.eligibility.quarantine ? " ⚠ quarantined" : "";
    lines.push(
      `  ${e.asset.padEnd(5)}  ${paper}  ${live}  hash=${e.config_hash.slice(0, 12)}…${q}`,
    );
  }
  lines.push("");
  lines.push(`see manifest.json and manifest.md for full detail.`);
  return `${lines.join("\n")}\n`;
}
