import { type Timeframe, TIMEFRAMES } from "@wiggler/constants/candles";
import { env } from "@wiggler/constants/env";
import {
  LOOKAHEAD_SOURCES,
  type LookaheadSource,
} from "@wiggler/lib/candles/lookahead";
import { loadClosePoints } from "@wiggler/lib/candles/queries";
import { buildWinProbGrid } from "@wiggler/lib/candles/winProbGrid";
import {
  readWinProbGridCache,
  winProbGridCachePath,
  type WinProbGridFingerprint,
  writeWinProbGridCache,
} from "@wiggler/lib/candles/winProbGridCache";
import {
  buildWigglerProbGridConfig,
  DEFAULT_RISK_AND_FEE,
  type WigglerProbGridConfig,
} from "@wiggler/lib/candles/winProbGridConfig";
import { defineCommand, defineFlagOption, defineValueOption } from "@wiggler/lib/cli";
import { CliUsageError } from "@wiggler/lib/cli/parser";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { z } from "zod";

/**
 * Computes the calibrated win-probability grid wiggler consumes at
 * runtime. Reads ascending close prices from the chosen training-label
 * source (default `vwap` — the cross-source aggregate), generates
 * decision-state rows at every minute boundary inside each interval,
 * buckets by `(remaining_sec, abs_d_bps, vol_bin)`, and emits a JSON
 * config artifact to `tmp/win-prob-grid/`.
 *
 * Output is the contract between wiggler-data and wiggler. Schema
 * version is `wiggler-prob-grid-v1`.
 *
 * Caching: per `(symbol, timeframe, interval_sec, label_source,
 * anchor_mode)`. Invalidated when the input rowcount or last
 * interval-end timestamp moves.
 */
export const candlesWinProbGridCommand = defineCommand({
  name: "candles:win-prob-grid",
  summary:
    "Compute the calibrated win-probability grid wiggler reads at runtime",
  description:
    "Streams close prices for the chosen training source and asset, generates decision-state rows at integer-minute boundaries inside each fixed-window market, buckets by (remaining_sec, abs_d_bps, vol_bin), and writes a JSON config (`wiggler-prob-grid-v1`) to `tmp/win-prob-grid/`. Default training source is `vwap` (cross-source aggregate) — used as a Chainlink proxy. The output config is the contract wiggler reads at runtime; basis risk versus the live Chainlink resolution feed is logged in the config and is unmeasured at training time.",
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
      description: `Training-label source. One of: ${LOOKAHEAD_SOURCES.join(", ")}. Default: vwap.`,
    }),
    defineValueOption({
      key: "intervalSec",
      long: "--interval-sec",
      valueName: "SEC",
      schema: z.coerce.number().int().min(120).default(300),
      description:
        "Market interval in seconds. Must be a multiple of 60 ≥ 120. Default: 300 (5m).",
    }),
    defineValueOption({
      key: "anchorStepMin",
      long: "--anchor-step-min",
      valueName: "MIN",
      schema: z.coerce.number().int().min(1).default(1),
      description:
        "Anchor stride in minutes. 1 = rolling (default, max sample size). Set to interval-min for boundary-aligned validation.",
    }),
    defineValueOption({
      key: "volLookbackMin",
      long: "--vol-lookback-min",
      valueName: "MIN",
      schema: z.coerce.number().int().min(5).default(30),
      description:
        "Lookback window (minutes) for the recent-vol estimate at decision time. Default: 30.",
    }),
    defineValueOption({
      key: "takerFeeRate",
      long: "--taker-fee-rate",
      valueName: "RATE",
      schema: z.coerce.number().min(0).max(0.5).optional(),
      description:
        "Polymarket taker fee rate written into the output config (default 0.072). Wiggler is free to override at runtime.",
    }),
    defineValueOption({
      key: "minRemainingSecToTrade",
      long: "--min-remaining-sec-to-trade",
      valueName: "SEC",
      schema: z.coerce.number().int().min(0).optional(),
      description:
        "Risk default written into the output config: refuse to trade when remaining < this. Default 60 (we have no sub-minute training data).",
    }),
    defineValueOption({
      key: "trainEndIso",
      long: "--train-end-iso",
      valueName: "ISO",
      schema: z.string().optional(),
      description:
        "ISO 8601 timestamp. Train only on anchors with open_time ≤ this. Used to leave a temporal-holdout window for out-of-sample calibration.",
    }),
    defineValueOption({
      key: "trainStartIso",
      long: "--train-start-iso",
      valueName: "ISO",
      schema: z.string().optional(),
    }),
    defineFlagOption({
      key: "json",
      long: "--json",
      schema: z.boolean().default(false),
      description: "Print the full config JSON to stdout instead of a summary.",
    }),
    defineFlagOption({
      key: "noCache",
      long: "--no-cache",
      schema: z.boolean().default(false),
    }),
  ],
  examples: [
    "bun wiggler candles:win-prob-grid",
    "bun wiggler candles:win-prob-grid --label-source vwap --interval-sec 300",
    "bun wiggler candles:win-prob-grid --anchor-step-min 5  # boundary-aligned validation pass",
    "bun wiggler candles:win-prob-grid --json | jq '.config_hash'",
    "bun wiggler candles:win-prob-grid --no-cache",
  ],
  output:
    "Writes a JSON config (`wiggler-prob-grid-v1`) to `tmp/win-prob-grid/{SYMBOL}_{TF}_{INTERVAL}s_{LABEL_SOURCE}_{anchor_mode}.json`. Prints either a one-page summary (default) or the full config (`--json`).",
  sideEffects:
    "Reads PostgreSQL (`candles` and `candle_vwap`). Writes one JSON file under `tmp/win-prob-grid/` unless `--no-cache` is set.",
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
    const intervalMin = intervalSec / 60;
    const anchorStepMin = options.anchorStepMin;
    if (anchorStepMin > intervalMin) {
      throw new CliUsageError(
        `--anchor-step-min (${anchorStepMin}) cannot exceed interval-min (${intervalMin})`,
      );
    }
    const anchorMode: "rolling" | "boundary" =
      anchorStepMin === intervalMin ? "boundary" : "rolling";

    const trainStartMs = options.trainStartIso
      ? parseIsoMs(options.trainStartIso, "--train-start-iso")
      : undefined;
    const trainEndMs = options.trainEndIso
      ? parseIsoMs(options.trainEndIso, "--train-end-iso")
      : undefined;
    if (
      trainStartMs !== undefined &&
      trainEndMs !== undefined &&
      trainStartMs >= trainEndMs
    ) {
      throw new CliUsageError(
        "--train-start-iso must precede --train-end-iso",
      );
    }
    const trainSlice =
      trainStartMs !== undefined || trainEndMs !== undefined
        ? `_train${trainStartMs ?? "BEGIN"}-${trainEndMs ?? "END"}`
        : "";

    const db = createDatabase();
    try {
      const closes = await loadClosePoints(db, {
        source: labelSource,
        symbol,
        timeframe,
      });
      if (closes.length === 0) {
        throw new CliUsageError(
          `no candles for (source=${labelSource}, symbol=${symbol}, timeframe=${timeframe}). Run candles:sync (and candles:vwap if label_source=vwap) first.`,
        );
      }
      const fingerprint: WinProbGridFingerprint = {
        rowCount: closes.length,
        latestIntervalEndMs: closes[closes.length - 1]!.tsMs,
      };
      const cachePath = winProbGridCachePath({
        symbol,
        timeframe,
        intervalSec,
        labelSource,
        anchorMode,
        suffix: trainSlice,
      });
      let cacheStatus: "hit" | "miss" | "skipped" = "skipped";
      let config: WigglerProbGridConfig | null = null;

      if (!options.noCache) {
        const cached = await readWinProbGridCache(cachePath, fingerprint);
        if (cached !== null) {
          config = cached.config;
          cacheStatus = "hit";
        }
      }

      if (config === null) {
        const grid = buildWinProbGrid({
          closes,
          intervalSec,
          anchorStepMin,
          volLookbackMin: options.volLookbackMin,
          trainStartMs,
          trainEndMs,
        });
        config = buildWigglerProbGridConfig({
          grid,
          asset: symbol,
          trainingLabelSource: labelSource,
          volLookbackMin: options.volLookbackMin,
          riskDefaults: {
            taker_fee_rate:
              options.takerFeeRate ?? DEFAULT_RISK_AND_FEE.taker_fee_rate,
            min_remaining_sec_to_trade:
              options.minRemainingSecToTrade ??
              DEFAULT_RISK_AND_FEE.min_remaining_sec_to_trade,
          },
        });
        if (!options.noCache) {
          await writeWinProbGridCache(cachePath, {
            cache_version: 1,
            fingerprint,
            config,
          });
          cacheStatus = "miss";
        } else {
          cacheStatus = "skipped";
        }
      }

      if (options.json) {
        io.writeStdout(`${JSON.stringify(config, null, 2)}\n`);
        return;
      }
      io.writeStdout(formatSummary({ config, cachePath, cacheStatus }));
    } finally {
      await destroyDatabase(db);
    }
  },
});

function parseIsoMs(value: string, label: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new CliUsageError(
      `${label}: invalid ISO 8601 timestamp: ${value}`,
    );
  }
  return ms;
}

function validateLabelSource(value: string): LookaheadSource {
  const allowed = new Set<string>(LOOKAHEAD_SOURCES);
  if (!allowed.has(value)) {
    throw new CliUsageError(
      `unknown --label-source: ${value}. Supported: ${LOOKAHEAD_SOURCES.join(", ")}.`,
    );
  }
  return value as LookaheadSource;
}

function formatSummary(args: {
  config: WigglerProbGridConfig;
  cachePath: string;
  cacheStatus: "hit" | "miss" | "skipped";
}): string {
  const { config } = args;
  const lines: string[] = [];
  lines.push(`asset:                  ${config.asset}`);
  lines.push(`market_type:            ${config.market_type}`);
  lines.push(`interval_sec:           ${config.interval_sec}`);
  lines.push(`anchor_mode:            ${config.anchor_mode}`);
  lines.push(`label_source:           ${config.training_input.label_source}`);
  lines.push(
    `training rowcount:      ${config.training_input.rowcount.toLocaleString("en-US")}`,
  );
  lines.push(
    `training window:        ${formatMsRange(config.training_input.window_start_ms, config.training_input.window_end_ms)}`,
  );
  lines.push(
    `up / down anchors:      ${config.totals.up_win_anchors.toLocaleString("en-US")} up / ${config.totals.down_win_anchors.toLocaleString("en-US")} down`,
  );
  lines.push(
    `taker fee rate:         ${config.fee.taker_fee_rate} (formula: ${config.fee.formula})`,
  );
  lines.push(
    `min remaining_sec:      ${config.risk_defaults.min_remaining_sec_to_trade}`,
  );
  lines.push(`min bucket count:       ${config.risk_defaults.min_bucket_count}`);
  lines.push(
    `vol thresholds (bps):   low≤${formatNum(config.vol_bins.thresholds_bps_per_sqrt_min.lowMaxBpsPerSqrtMin)} | normal≤${formatNum(config.vol_bins.thresholds_bps_per_sqrt_min.normalMaxBpsPerSqrtMin)} | high≤${formatNum(config.vol_bins.thresholds_bps_per_sqrt_min.highMaxBpsPerSqrtMin)} | extreme>${formatNum(config.vol_bins.thresholds_bps_per_sqrt_min.highMaxBpsPerSqrtMin)}`,
  );
  lines.push(`buckets emitted:        ${config.grid.length.toLocaleString("en-US")}`);
  const populated = config.grid.filter((g) => g.count > 0);
  lines.push(
    `populated buckets:      ${populated.length.toLocaleString("en-US")}`,
  );
  lines.push(`config_hash:            ${config.config_hash}`);
  lines.push(
    `git:                    ${config.git.commit_sha ?? "unknown"}${config.git.dirty ? " (dirty worktree)" : ""}`,
  );
  lines.push(`cache:                  ${args.cacheStatus} → ${args.cachePath}`);
  lines.push("");
  lines.push(
    "tip: run with --json to emit the full config to stdout (e.g. for piping into wiggler).",
  );
  return `${lines.join("\n")}\n`;
}

function formatMsRange(startMs: number | null, endMs: number | null): string {
  if (startMs === null || endMs === null) {
    return "(empty)";
  }
  const start = new Date(startMs).toISOString();
  const end = new Date(endMs).toISOString();
  const days = Math.round((endMs - startMs) / 86_400_000);
  return `${start} → ${end} (~${days}d)`;
}

function formatNum(value: number): string {
  return value.toFixed(2);
}
