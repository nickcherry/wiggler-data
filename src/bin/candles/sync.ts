import {
  CANDLE_SOURCES,
  type CandleSource,
  type Timeframe,
  TIMEFRAMES,
} from "@wiggler/constants/candles";
import { env } from "@wiggler/constants/env";
import { syncManyCandleSeries } from "@wiggler/lib/candles/sync";
import { defineCommand, defineFlagOption, defineValueOption } from "@wiggler/lib/cli";
import { CliUsageError } from "@wiggler/lib/cli/parser";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { parseDurationMs } from "@wiggler/lib/time/durations";
import { createShutdownController } from "@wiggler/lib/util/signal";
import { z } from "zod";

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Backfills (or refreshes) historical OHLCV candles for one or more
 * symbols across one or more sources. Idempotent at the row level — the
 * upsert PK on `(source, symbol, timeframe, open_time)` makes re-running
 * over an already-fetched window a cheap no-op. Resumes from the most
 * recent `open_time_ms` per series unless `--force-full-range` is set.
 */
export const candlesSyncCommand = defineCommand({
  name: "candles:sync",
  summary: "Backfill historical OHLCV candles from one or more CEX sources",
  description:
    "For every (source, symbol) combination requested, fetches missing candles in the requested timeframe up to `now` and upserts them into the `candles` table. Sources are run in parallel; pagination respects each provider's rate limits. The default symbol is the configured DEFAULT_ASSET; the default sources are every supported source; the default lookback is 1 year.",
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
      key: "forceFullRange",
      long: "--force-full-range",
      schema: z
        .boolean()
        .default(false)
        .describe(
          "Bypass the resume cursor and fetch the full requested range, re-upserting every row.",
        ),
    }),
    defineFlagOption({
      key: "json",
      long: "--json",
      schema: z.boolean().default(false),
    }),
  ],
  examples: [
    "bun wiggler candles:sync",
    "bun wiggler candles:sync --symbols BTC,ETH --since 30d",
    "bun wiggler candles:sync --sources coinbase,binance --since 1y",
    "bun wiggler candles:sync --timeframe 1h --force-full-range",
  ],
  output:
    "Prints one summary line per (source, symbol) with rows upserted and status (or JSON).",
  sideEffects:
    "Issues paginated HTTP GETs against each enabled CEX REST endpoint and upserts rows into PostgreSQL.",
  async run({ io, options }) {
    const symbols = options.symbols
      ? splitCsv(options.symbols).map((s) => s.toUpperCase())
      : env.defaultSymbols;
    const sources = options.sources
      ? validateSources(splitCsv(options.sources))
      : (CANDLE_SOURCES as readonly CandleSource[]);
    const timeframe: Timeframe = options.timeframe;
    const sinceMs = parseSince(options.since);
    const toMs = Date.now();
    const fromMs = toMs - sinceMs;

    if (symbols.length === 0) {
      throw new CliUsageError("--symbols cannot be empty.");
    }
    if (sources.length === 0) {
      throw new CliUsageError("--sources cannot be empty.");
    }

    const controller = createShutdownController();
    const db = createDatabase();
    try {
      const results = await syncManyCandleSeries(db, {
        sources,
        symbols,
        timeframe,
        fromMs,
        toMs,
        forceFullRange: options.forceFullRange,
        signal: controller.signal,
      });

      if (options.json) {
        io.writeStdout(
          `${JSON.stringify(
            {
              timeframe,
              symbols,
              sources,
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
          `sources:    ${sources.join(",")}`,
          `from:       ${new Date(fromMs).toISOString()}`,
          `to:         ${new Date(toMs).toISOString()}`,
          "",
          "source     symbol  status     rows_upserted  note",
        ];
        for (const r of results) {
          const note = r.error ? r.error : r.alreadyCurrent ? "already current" : "";
          lines.push(
            `${r.source.padEnd(10)} ${r.symbol.padEnd(6)}  ${r.status.padEnd(9)}  ${String(r.rowsUpserted).padStart(13)}  ${note}`,
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

function validateSources(values: readonly string[]): readonly CandleSource[] {
  const allowed = new Set<string>(CANDLE_SOURCES);
  const out: CandleSource[] = [];
  for (const v of values) {
    const lower = v.toLowerCase();
    if (!allowed.has(lower)) {
      throw new CliUsageError(
        `unknown source: ${v}. Supported: ${CANDLE_SOURCES.join(", ")}.`,
      );
    }
    out.push(lower as CandleSource);
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
