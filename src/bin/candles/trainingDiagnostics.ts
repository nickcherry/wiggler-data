import { type Timeframe, TIMEFRAMES } from "@wiggler/constants/candles";
import { env } from "@wiggler/constants/env";
import {
  LOOKAHEAD_SOURCES,
  type LookaheadSource,
} from "@wiggler/lib/candles/lookahead";
import { loadClosePoints } from "@wiggler/lib/candles/queries";
import {
  buildTieAndAnchorDiagnostics,
  loadSourceCompositionByMonth,
  type TrainingDiagnostics,
} from "@wiggler/lib/candles/trainingDiagnostics";
import { defineCommand, defineFlagOption, defineValueOption } from "@wiggler/lib/cli";
import { CliUsageError } from "@wiggler/lib/cli/parser";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { z } from "zod";

/**
 * Surfaces the data-quality conditions that produce suspicious-looking
 * win-prob grids: tie counts, per-month Up/Down anchor imbalance, and
 * per-month vwap source composition. Run this BEFORE trusting an
 * asset's grid for trading.
 *
 * Concrete conditions to check for:
 *
 *   - Sustained `upShare > 0.6` or `< 0.4` per month indicates that
 *     the proxy is drifting one direction without a real economic
 *     reason — usually source-composition shift.
 *   - High `currentEqualsLine` or `finalEqualsLine` counts mean the
 *     tie-to-Up rule has outsized influence. The `at_line` bucket in
 *     the grid will dominate.
 *   - `uniqueSources` jumps up mid-window mean a new venue started
 *     contributing to the vwap and the proxy is mechanically shifting.
 */
export const candlesTrainingDiagnosticsCommand = defineCommand({
  name: "candles:training-diagnostics",
  summary:
    "Tie counts, anchor balance over time, and per-month source composition",
  description:
    "Surfaces the data-quality conditions that produce suspicious-looking win-prob grids. Reports tie / near-tie decision-state counts, monthly Up/Down anchor balance (imbalance growing with time often points to proxy drift), and per-month source composition for the vwap aggregate. Run before trusting an asset's grid for trading.",
  options: [
    defineValueOption({
      key: "symbol",
      long: "--symbol",
      valueName: "SYMBOL",
      schema: z.string().optional(),
    }),
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
      schema: z.coerce.number().int().min(1).default(1),
    }),
    defineValueOption({
      key: "volLookbackMin",
      long: "--vol-lookback-min",
      valueName: "MIN",
      schema: z.coerce.number().int().min(5).default(30),
    }),
    defineFlagOption({
      key: "json",
      long: "--json",
      schema: z.boolean().default(false),
    }),
  ],
  examples: [
    "bun wiggler candles:training-diagnostics --symbol HYPE  # check the suspicious asset",
    "bun wiggler candles:training-diagnostics --symbol BTC --json",
  ],
  output:
    "Prints tie counts, monthly anchor balance, and monthly vwap source composition.",
  sideEffects: "Reads PostgreSQL.",
  async run({ io, options }) {
    const symbol = (options.symbol ?? env.defaultAsset).toUpperCase();
    const timeframe: Timeframe = options.timeframe;
    const labelSource = validateLabelSource(options.labelSource);
    const intervalSec = options.intervalSec;
    if (intervalSec % 60 !== 0) {
      throw new CliUsageError(
        `--interval-sec must be a multiple of 60, got ${intervalSec}`,
      );
    }
    const anchorStepMin = options.anchorStepMin;

    const db = createDatabase();
    try {
      const closes = await loadClosePoints(db, {
        source: labelSource,
        symbol,
        timeframe,
      });
      if (closes.length === 0) {
        throw new CliUsageError(
          `no candles for (source=${labelSource}, symbol=${symbol}, timeframe=${timeframe}).`,
        );
      }
      const tieAndAnchor = buildTieAndAnchorDiagnostics({
        closes,
        intervalSec,
        anchorStepMin,
        volLookbackMin: options.volLookbackMin,
      });
      const sourceComposition = await loadSourceCompositionByMonth(db, {
        symbol,
        timeframe,
      });

      const totalAnchors = tieAndAnchor.upAnchors + tieAndAnchor.downAnchors;
      const report: TrainingDiagnostics = {
        asset: symbol,
        timeframe,
        intervalSec,
        windowStartIso:
          closes.length > 0
            ? new Date(closes[0]!.tsMs).toISOString()
            : null,
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

      if (options.json) {
        io.writeStdout(`${JSON.stringify(report, null, 2)}\n`);
        return;
      }
      io.writeStdout(formatReport(report));
    } finally {
      await destroyDatabase(db);
    }
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

function formatReport(report: TrainingDiagnostics): string {
  const lines: string[] = [];
  lines.push(`asset:                ${report.asset}`);
  lines.push(`interval_sec:         ${report.intervalSec}`);
  lines.push(`window:               ${report.windowStartIso} → ${report.windowEndIso}`);
  lines.push(
    `total anchors:        ${(report.upAnchors + report.downAnchors).toLocaleString("en-US")} (up: ${report.upAnchors.toLocaleString("en-US")} / down: ${report.downAnchors.toLocaleString("en-US")} → up share ${(report.upShareAll * 100).toFixed(2)}%)`,
  );
  if (Math.abs(report.upShareAll - 0.5) > 0.05) {
    lines.push(
      `  ↑ FLAG: anchor up-share is more than 5pp from 50%. Investigate before trusting this asset's grid.`,
    );
  }
  lines.push("");
  lines.push(`Tie diagnostics`);
  lines.push(`  decision rows scanned:   ${report.ties.decisionRows.toLocaleString("en-US")}`);
  lines.push(`  current_price == line:   ${report.ties.currentEqualsLine.toLocaleString("en-US")}`);
  lines.push(`  final_price == line:     ${report.ties.finalEqualsLine.toLocaleString("en-US")}`);
  for (const t of report.ties.absDBpsBelowEpsilon) {
    lines.push(
      `  abs_d_bps < ${t.epsilon.toString().padStart(3)} bps:        ${t.count.toLocaleString("en-US")}`,
    );
  }
  lines.push("");
  lines.push(`Anchor balance by month`);
  lines.push("  month     up   down   total   up_share");
  for (const m of report.anchorBalanceByMonth) {
    const total = m.upWins + m.downWins;
    const flag = Math.abs(m.upShare - 0.5) > 0.05 ? " ⚠" : "";
    lines.push(
      `  ${m.monthIso}  ${String(m.upWins).padStart(5)}  ${String(m.downWins).padStart(5)}  ${String(total).padStart(5)}    ${(m.upShare * 100).toFixed(2)}%${flag}`,
    );
  }
  lines.push("");
  lines.push(`Source composition by month (raw candles per source)`);
  lines.push("  month     unique_sources  per_source_rows");
  for (const m of report.sourceCompositionByMonth) {
    const perSrc = m.perSource
      .map((s) => `${s.source}:${s.rows}`)
      .join(" ");
    lines.push(
      `  ${m.monthIso}        ${String(m.uniqueSources).padStart(2)}            ${perSrc}`,
    );
  }
  lines.push("");
  lines.push(
    "  ⚠ marks months where Up share is more than 5pp from 50%. A run of consecutive ⚠'s often points to source-composition drift in the vwap proxy.",
  );
  return `${lines.join("\n")}\n`;
}
