import { type Timeframe, TIMEFRAMES } from "@wiggler/constants/candles";
import { env } from "@wiggler/constants/env";
import {
  buildCalibrationReport,
  type CalibrationReport,
} from "@wiggler/lib/candles/calibrationReport";
import {
  LOOKAHEAD_SOURCES,
  type LookaheadSource,
} from "@wiggler/lib/candles/lookahead";
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
 * Predicted-vs-realized check on the win-probability grid. Replays
 * decision states against the same series the grid was trained on,
 * looks up each state's `p_win_lower`, and bins by that probability.
 * The realized win rate inside each `p_win_lower` bin should be
 * AT-LEAST the bin's lower bound. Bins where realized < predicted
 * indicate the lower bound is over-promising — strong reason not to
 * trust those cells live.
 *
 * Reads the cached config (run `candles:win-prob-grid` first) — does
 * not recompute the grid.
 */
export const candlesCalibrationReportCommand = defineCommand({
  name: "candles:calibration-report",
  summary:
    "Predicted-vs-realized calibration of the win-probability grid",
  description:
    "Replays decision states from `candles` (or `candle_vwap`) against the cached `wiggler-prob-grid-v1` config and reports realized win rate by `p_win_lower` decile. Run `candles:win-prob-grid` first to populate the cache. Realized-below-predicted bins mean the lower bound is over-confident — wiggler should not trade those cells.",
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
    "bun wiggler candles:calibration-report",
    "bun wiggler candles:calibration-report --anchor-mode boundary  # validate against true 5m boundaries",
    "bun wiggler candles:calibration-report --json",
  ],
  output:
    "Prints one row per `p_win_lower` decile: count, realized win rate, mean predicted, gap.",
  sideEffects:
    "Reads PostgreSQL. Reads the cached config under `tmp/win-prob-grid/`.",
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
          `no fresh cached config at ${cachePath}. Run candles:win-prob-grid first (with matching --anchor-step-min if applicable).`,
        );
      }
      const report = buildCalibrationReport({
        config: cached.config,
        closes,
        volLookbackMin: options.volLookbackMin,
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

function formatReport(report: CalibrationReport, cachePath: string): string {
  const lines: string[] = [];
  lines.push(`asset:           ${report.asset}`);
  lines.push(`interval_sec:    ${report.intervalSec}`);
  lines.push(`anchor_mode:     ${report.anchorMode}`);
  lines.push(`config:          ${cachePath}`);
  lines.push(
    `rows scanned:    ${report.totalRows.toLocaleString("en-US")}`,
  );
  lines.push(
    `max abs gap:     ${formatPct(report.maxAbsGap)}  (predicted vs realized — ↑ = worse calibration)`,
  );
  lines.push("");
  lines.push(
    "p_win_lower bin     count       wins   realized    predicted    gap",
  );
  for (const bin of report.bins) {
    if (bin.count === 0) {continue;}
    const range = `[${bin.pWinLowerMin.toFixed(2)}, ${bin.pWinLowerMax.toFixed(2)})`;
    const gap = bin.realizedWinRate - bin.meanPredicted;
    const gapSign = gap >= 0 ? "+" : "−";
    lines.push(
      `${range.padEnd(18)}  ${String(bin.count).padStart(8)}  ${String(bin.wins).padStart(8)}  ${formatPct(bin.realizedWinRate).padStart(8)}    ${formatPct(bin.meanPredicted).padStart(8)}   ${gapSign}${formatPct(Math.abs(gap)).padStart(7)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}
