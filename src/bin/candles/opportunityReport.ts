import { type Timeframe, TIMEFRAMES } from "@wiggler/constants/candles";
import { env } from "@wiggler/constants/env";
import {
  LOOKAHEAD_SOURCES,
  type LookaheadSource,
} from "@wiggler/lib/candles/lookahead";
import {
  buildOpportunityReport,
  DEFAULT_OPPORTUNITY_THRESHOLDS,
  type OpportunityReport,
} from "@wiggler/lib/candles/opportunityReport";
import { loadClosePoints } from "@wiggler/lib/candles/queries";
import {
  readWinProbGridCache,
  winProbGridCachePath,
  type WinProbGridFingerprint,
} from "@wiggler/lib/candles/winProbGridCache";
import { defineCommand, defineFlagOption, defineValueOption } from "@wiggler/lib/cli";
import { CliUsageError } from "@wiggler/lib/cli/parser";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { z } from "zod";

/**
 * "How often did the historical model reach a given confidence
 * threshold?" Answers whether wiggler would see enough tradeable
 * signals to be worth running, before any order-book backtest exists.
 *
 * Reads the cached `wiggler-prob-grid-v1` config and counts decision
 * states whose `p_win_lower` exceeds each threshold (0.70 / 0.80 /
 * 0.90 / 0.95 / 0.98 by default), excluding buckets smaller than
 * `min_bucket_count` (those wouldn't be tradeable anyway).
 */
export const candlesOpportunityReportCommand = defineCommand({
  name: "candles:opportunity-report",
  summary: "How many high-confidence signals would the model produce per day?",
  description:
    "Reads the cached `wiggler-prob-grid-v1` config and reports, for each `p_win_lower` threshold, the total decision states that crossed it across the training window. Breaks down by remaining_sec and vol_bin so you can see where the signal lives. Skips buckets smaller than `min_bucket_count` — those wouldn't be tradeable under wiggler's risk defaults regardless. Run `candles:win-prob-grid` first.",
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
      key: "anchorMode",
      long: "--anchor-mode",
      valueName: "MODE",
      schema: z.enum(["rolling", "boundary"]).default("rolling"),
    }),
    defineValueOption({
      key: "thresholds",
      long: "--thresholds",
      valueName: "CSV",
      schema: z.string().optional(),
      description:
        "Comma-separated probability thresholds. Default: 0.70,0.80,0.90,0.95,0.98.",
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
    "bun wiggler candles:opportunity-report",
    "bun wiggler candles:opportunity-report --thresholds 0.85,0.92,0.97",
    "bun wiggler candles:opportunity-report --anchor-mode boundary --json",
  ],
  output:
    "Prints one row per threshold: total signals, signals/day, breakdown by remaining_sec and vol_bin.",
  sideEffects: "Reads PostgreSQL. Reads cached config under `tmp/win-prob-grid/`.",
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
    const anchorMode = options.anchorMode;
    const thresholds = options.thresholds
      ? parseThresholds(options.thresholds)
      : DEFAULT_OPPORTUNITY_THRESHOLDS;

    const cachePath = winProbGridCachePath({
      symbol,
      timeframe,
      intervalSec,
      labelSource,
      anchorMode,
    });

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
      const fingerprint: WinProbGridFingerprint = {
        rowCount: closes.length,
        latestIntervalEndMs: closes[closes.length - 1]!.tsMs,
      };
      const cached = await readWinProbGridCache(cachePath, fingerprint);
      if (cached === null) {
        throw new CliUsageError(
          `no fresh cached config at ${cachePath}. Run candles:win-prob-grid first.`,
        );
      }
      const report = buildOpportunityReport({
        config: cached.config,
        closes,
        volLookbackMin: options.volLookbackMin,
        thresholds,
      });
      if (options.json) {
        io.writeStdout(`${JSON.stringify(report, null, 2)}\n`);
        return;
      }
      io.writeStdout(formatReport(report, cachePath));
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

function parseThresholds(csv: string): readonly number[] {
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const value = Number(s);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new CliUsageError(
          `--thresholds entries must be probabilities in [0, 1], got "${s}"`,
        );
      }
      return value;
    });
}

function formatReport(report: OpportunityReport, cachePath: string): string {
  const lines: string[] = [];
  lines.push(`asset:                  ${report.asset}`);
  lines.push(`interval_sec:           ${report.intervalSec}`);
  lines.push(`anchor_mode:            ${report.anchorMode}`);
  lines.push(`config:                 ${cachePath}`);
  lines.push(`training window:        ~${report.windowDays.toFixed(1)} days`);
  lines.push(
    `tradable rows scanned:  ${report.tradableRowsScanned.toLocaleString("en-US")}  (cells where count ≥ min_bucket_count)`,
  );
  lines.push(
    `intervals scanned:      ${report.intervalsScanned.toLocaleString("en-US")}`,
  );
  lines.push("");
  lines.push(
    "                    bucket-level          interval-level          avg",
  );
  lines.push(
    "threshold      rows/day      total       ints/day      total       rows/int",
  );
  for (const row of report.rows) {
    lines.push(
      `${`p_lower≥${row.threshold.toFixed(2)}`.padEnd(13)} ${row.rowsPerDay.toFixed(1).padStart(7)}  ${row.rowsAbove.toLocaleString("en-US").padStart(10)}   ${row.intervalsPerDay.toFixed(1).padStart(7)}  ${row.intervalsSignaling.toLocaleString("en-US").padStart(10)}     ${row.meanRowsPerSignalingInterval.toFixed(2).padStart(5)}`,
    );
  }
  lines.push("");
  lines.push(
    "  bucket-level: number of decision rows above threshold.",
  );
  lines.push(
    "  interval-level: distinct 5m markets where AT LEAST ONE row crossed.",
  );
  lines.push(
    "  Wiggler trades a market once per signal → interval-level is the realistic cap on trades.",
  );
  return `${lines.join("\n")}\n`;
}
