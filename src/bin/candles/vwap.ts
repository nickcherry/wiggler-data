import { type Timeframe, TIMEFRAMES } from "@wiggler/constants/candles";
import { env } from "@wiggler/constants/env";
import { computeManyVwapSeries } from "@wiggler/lib/candles/vwap";
import { defineCommand, defineFlagOption, defineValueOption } from "@wiggler/lib/cli";
import { CliUsageError } from "@wiggler/lib/cli/parser";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { parseDurationMs } from "@wiggler/lib/time/durations";
import { z } from "zod";

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Computes cross-source VWAP rows from `candles` and upserts them into
 * `candle_vwap`. For each `(symbol, timeframe, open_time)` bucket where
 * ≥1 source has a candle, materializes a single fused price weighted by
 * each source's volume.
 *
 * Idempotent — re-running over an already-computed window simply
 * refreshes `vwap_e8`, `total_volume_e8`, `source_count`, and
 * `computed_at` in place.
 */
export const candlesVwapCommand = defineCommand({
  name: "candles:vwap",
  summary: "Compute cross-source VWAP rows from candles",
  description:
    "For every (symbol, timeframe, open_time) where at least one source has a candle, computes the volume-weighted average of typical prices ((H+L+C)/3) across all available sources and upserts the result into `candle_vwap`. The default symbol is the configured DEFAULT_ASSET, the default timeframe is 1m, and the default lookback is 1 year.",
  options: [
    defineValueOption({
      key: "symbols",
      long: "--symbols",
      valueName: "CSV",
      schema: z.string().optional(),
    }),
    defineValueOption({
      key: "timeframe",
      long: "--timeframe",
      valueName: "TF",
      schema: z.enum(TIMEFRAMES).default("1m"),
    }),
    defineValueOption({
      key: "since",
      long: "--since",
      valueName: "DURATION",
      schema: z.string().default("1y"),
    }),
    defineFlagOption({
      key: "json",
      long: "--json",
      schema: z.boolean().default(false),
    }),
  ],
  examples: [
    "bun wiggler candles:vwap",
    "bun wiggler candles:vwap --symbols BTC,ETH --since 30d",
    "bun wiggler candles:vwap --timeframe 1h",
  ],
  output:
    "Prints one summary line per symbol with rows computed / upserted / status (or JSON).",
  sideEffects:
    "Reads from `candles` and upserts into `candle_vwap`. No external network calls.",
  async run({ io, options }) {
    const symbols = options.symbols
      ? splitCsv(options.symbols).map((s) => s.toUpperCase())
      : env.defaultSymbols;
    const timeframe: Timeframe = options.timeframe;
    const sinceMs = parseSince(options.since);
    const toMs = Date.now();
    const fromMs = toMs - sinceMs;

    if (symbols.length === 0) {
      throw new CliUsageError("--symbols cannot be empty.");
    }

    const db = createDatabase();
    try {
      const results = await computeManyVwapSeries(db, {
        symbols,
        timeframe,
        fromMs,
        toMs,
      });

      if (options.json) {
        io.writeStdout(
          `${JSON.stringify(
            {
              timeframe,
              symbols,
              fromTs: new Date(fromMs).toISOString(),
              toTs: new Date(toMs).toISOString(),
              results,
            },
            null,
            2,
          )}\n`,
        );
      } else {
        const lines = [
          `timeframe:  ${timeframe}`,
          `symbols:    ${symbols.join(",")}`,
          `from:       ${new Date(fromMs).toISOString()}`,
          `to:         ${new Date(toMs).toISOString()}`,
          "",
          "symbol  status     rows_computed  rows_upserted  note",
        ];
        for (const r of results) {
          const note = r.error ?? "";
          lines.push(
            `${r.symbol.padEnd(6)}  ${r.status.padEnd(9)}  ${String(r.rowsComputed).padStart(13)}  ${String(r.rowsUpserted).padStart(13)}  ${note}`,
          );
        }
        io.writeStdout(`${lines.join("\n")}\n`);
      }

      const anyFailed = results.some((r) => r.status === "failed");
      if (anyFailed) {
        process.exitCode = 1;
      }
    } finally {
      await destroyDatabase(db);
    }
  },
});

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseSince(input: string): number {
  // `parseDurationMs` handles ms, s, m, h, d. We extend it here with `y`.
  const yearMatch = /^(\d+(?:\.\d+)?)y$/.exec(input.trim());
  if (yearMatch) {
    const value = Number(yearMatch[1]);
    if (!Number.isFinite(value) || value <= 0) {
      throw new CliUsageError(`invalid --since value: ${input}`);
    }
    return value * ONE_YEAR_MS;
  }
  return parseDurationMs(input);
}
