import { type Timeframe, TIMEFRAMES } from "@wiggler/constants/candles";
import { env } from "@wiggler/constants/env";
import {
  computeManyLookaheadSeries,
  LOOKAHEAD_MINUTES,
  LOOKAHEAD_SOURCES,
  type LookaheadSource,
} from "@wiggler/lib/candles/lookahead";
import { defineCommand, defineFlagOption, defineValueOption } from "@wiggler/lib/cli";
import { CliUsageError } from "@wiggler/lib/cli/parser";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { parseDurationMs } from "@wiggler/lib/time/durations";
import { z } from "zod";

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Materializes per-candle lookahead features into
 * `candle_lookahead_features`. For every candle of every source (the
 * four CEX sources plus the cross-source `vwap` aggregate) and every
 * lookahead horizon in {1m, 2m, 3m, 4m, 5m}, computes:
 *
 *   max_up_move_bps               = 10_000 * (future_high / start_price - 1)
 *   max_down_move_bps             = 10_000 * (start_price / future_low - 1)
 *   max_abs_excursion_bps         = max(max_up_move_bps, max_down_move_bps)
 *   close_to_close_abs_return_bps = abs(10_000 * (end_price / start_price - 1))
 *   range_bps                     = 10_000 * (future_high / future_low - 1)
 *
 * Idempotent at the row level via the
 * `(source, symbol, timeframe, open_time, lookahead_min)` PK.
 *
 * Currently only the `1m` timeframe is supported — the lookahead
 * horizons are specified in minutes, and only 1m candles produce a
 * meaningful 1-minute lookahead. Other timeframes are rejected with
 * a usage error.
 */
export const candlesLookaheadCommand = defineCommand({
  name: "candles:lookahead",
  summary: "Compute per-candle forward-looking labels (max excursion, range, etc.)",
  description:
    "For every candle of every (source, symbol) — including the synthetic `vwap` source — computes 1m through 5m forward-looking labels (max up/down move, abs excursion, close-to-close return, range; all in basis points) and upserts the result into `candle_lookahead_features`. The default symbol is the configured DEFAULT_ASSET; the default sources are every CEX source plus `vwap`; the default lookback is 1 year.",
  options: [
    defineValueOption({
      key: "symbols",
      long: "--symbols",
      valueName: "CSV",
      schema: z.string().optional(),
    }),
    defineValueOption({
      key: "sources",
      long: "--sources",
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
    "bun wiggler candles:lookahead",
    "bun wiggler candles:lookahead --symbols BTC --sources vwap --since 30d",
    "bun wiggler candles:lookahead --sources coinbase,binance",
  ],
  output:
    "Prints one summary line per (source, symbol) with rows computed / upserted / status (or JSON).",
  sideEffects:
    "Reads from `candles` and `candle_vwap`, upserts into `candle_lookahead_features`. No external network calls.",
  async run({ io, options }) {
    const symbols = options.symbols
      ? splitCsv(options.symbols).map((s) => s.toUpperCase())
      : env.defaultSymbols;
    const sources = options.sources
      ? validateSources(splitCsv(options.sources))
      : (LOOKAHEAD_SOURCES as readonly LookaheadSource[]);
    const timeframe: Timeframe = options.timeframe;

    if (timeframe !== "1m") {
      throw new CliUsageError(
        `--timeframe ${timeframe} is not supported yet. Lookahead horizons are specified in minutes; currently only 1m candles produce a meaningful 1-minute lookahead.`,
      );
    }
    if (symbols.length === 0) {
      throw new CliUsageError("--symbols cannot be empty.");
    }
    if (sources.length === 0) {
      throw new CliUsageError("--sources cannot be empty.");
    }

    const sinceMs = parseSince(options.since);
    const toMs = Date.now();
    const fromMs = toMs - sinceMs;

    const db = createDatabase();
    try {
      const results = await computeManyLookaheadSeries(db, {
        sources,
        symbols,
        timeframe,
        fromMs,
        toMs,
        lookaheadMinutes: LOOKAHEAD_MINUTES,
      });

      if (options.json) {
        io.writeStdout(
          `${JSON.stringify(
            {
              timeframe,
              sources,
              symbols,
              lookaheadMinutes: LOOKAHEAD_MINUTES,
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
          `timeframe:   ${timeframe}`,
          `lookaheads:  ${LOOKAHEAD_MINUTES.join(",")} (minutes)`,
          `sources:     ${sources.join(",")}`,
          `symbols:     ${symbols.join(",")}`,
          `from:        ${new Date(fromMs).toISOString()}`,
          `to:          ${new Date(toMs).toISOString()}`,
          "",
          "source     symbol  status     rows_computed  rows_upserted  note",
        ];
        for (const r of results) {
          const note = r.error ?? "";
          lines.push(
            `${r.source.padEnd(10)} ${r.symbol.padEnd(6)}  ${r.status.padEnd(9)}  ${String(r.rowsComputed).padStart(13)}  ${String(r.rowsUpserted).padStart(13)}  ${note}`,
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

function validateSources(values: readonly string[]): readonly LookaheadSource[] {
  const allowed = new Set<string>(LOOKAHEAD_SOURCES);
  const out: LookaheadSource[] = [];
  for (const v of values) {
    const lower = v.toLowerCase();
    if (!allowed.has(lower)) {
      throw new CliUsageError(
        `unknown source: ${v}. Supported: ${LOOKAHEAD_SOURCES.join(", ")}.`,
      );
    }
    out.push(lower as LookaheadSource);
  }
  return out;
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
