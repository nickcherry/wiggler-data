import { type Timeframe, TIMEFRAMES } from "@wiggler/constants/candles";
import { env } from "@wiggler/constants/env";
import {
  LOOKAHEAD_SOURCES,
  type LookaheadSource,
} from "@wiggler/lib/candles/lookahead";
import {
  fingerprintsMatch,
  getLookaheadFingerprint,
  LOOKAHEAD_METRIC_DESCRIPTIONS,
  LOOKAHEAD_METRICS,
  type LookaheadDistribution,
  type LookaheadFingerprint,
  type LookaheadMetric,
  type LookaheadStatsRow,
  summarizeLookaheadDistributions,
} from "@wiggler/lib/candles/lookaheadStats";
import {
  distributionsCachePath,
  readDistributionsCache,
  writeDistributionsCache,
} from "@wiggler/lib/candles/lookaheadStatsCache";
import { defineCommand, defineFlagOption, defineValueOption } from "@wiggler/lib/cli";
import { CliUsageError } from "@wiggler/lib/cli/parser";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { z } from "zod";

/**
 * Reports percentile distributions of lookahead-feature metrics from
 * `candle_lookahead_features`, grouped by `(source, lookahead_min)`.
 * One table per metric, each preceded by a one-line description.
 *
 * Computation: live `PERCENTILE_CONT` on the indexed table, with an
 * on-disk JSON cache keyed on `(symbol, timeframe, sources, metrics)`
 * and invalidated by a cheap `(rowCount, latestOpenTimeMs)` fingerprint
 * of `candle_lookahead_features`. Subsequent runs with the same
 * request shape and unchanged underlying data skip the SQL entirely.
 *
 * Renders `vwap` as `aggregate` in human-readable mode, since users
 * conceptually think of it as "the cross-source aggregate" rather than
 * a raw exchange. Bolds metric titles + column headings and dims the
 * per-metric description line when stdout is a TTY (suppressed by
 * `--no-color` or when piping into a file).
 */
export const candlesDistributionsCommand = defineCommand({
  name: "candles:distributions",
  summary: "Print percentile distributions of lookahead features per (source, lookahead)",
  description:
    "Reads `candle_lookahead_features` and prints a percentile-distribution table for each requested metric (max_abs_excursion_bps, close_to_close_abs_return_bps, range_bps, max_up_move_bps, max_down_move_bps), grouped by exchange and lookahead horizon. All values are basis points (1 bps = 0.01%). Run `bun wiggler candles:lookahead` first to populate the source table. Results are cached to `tmp/distributions/` and reused when the underlying data hasn't changed.",
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
      key: "sources",
      long: "--sources",
      valueName: "CSV",
      schema: z.string().optional(),
    }),
    defineValueOption({
      key: "metrics",
      long: "--metrics",
      valueName: "CSV",
      schema: z.string().optional(),
    }),
    defineFlagOption({
      key: "json",
      long: "--json",
      schema: z.boolean().default(false),
    }),
    defineFlagOption({
      key: "noColor",
      long: "--no-color",
      schema: z
        .boolean()
        .default(false)
        .describe("Disable bold/dim ANSI escapes (auto-disabled when not a TTY)."),
    }),
    defineFlagOption({
      key: "noCache",
      long: "--no-cache",
      schema: z
        .boolean()
        .default(false)
        .describe("Skip both reading from and writing to the on-disk cache."),
    }),
  ],
  examples: [
    "bun wiggler candles:distributions",
    "bun wiggler candles:distributions --metrics max_abs_excursion_bps",
    "bun wiggler candles:distributions --sources coinbase,vwap",
    "bun wiggler candles:distributions --json",
    "bun wiggler candles:distributions --no-cache",
  ],
  output:
    "Prints one percentile table per metric, with rows per (exchange, lookahead). Or JSON when --json is set.",
  sideEffects:
    "Reads PostgreSQL. Reads/writes JSON cache files under `tmp/distributions/` unless --no-cache is set.",
  async run({ io, options }) {
    const symbol = (options.symbol ?? env.defaultAsset).toUpperCase();
    const timeframe: Timeframe = options.timeframe;
    const sources = options.sources
      ? validateSources(splitCsv(options.sources))
      : (LOOKAHEAD_SOURCES as readonly LookaheadSource[]);
    const metrics = options.metrics
      ? validateMetrics(splitCsv(options.metrics))
      : (LOOKAHEAD_METRICS as readonly LookaheadMetric[]);

    if (sources.length === 0) {
      throw new CliUsageError("--sources cannot be empty.");
    }
    if (metrics.length === 0) {
      throw new CliUsageError("--metrics cannot be empty.");
    }

    // ANSI formatting is on when stdout is a TTY and the user hasn't
    // opted out. Plain output for pipes, files, and `--json`.
    const useColor = !options.noColor && !options.json && process.stdout.isTTY === true;

    const db = createDatabase();
    try {
      const cachePath = distributionsCachePath({ symbol, timeframe, sources, metrics });
      const fingerprint = await getLookaheadFingerprint(db, { symbol, timeframe });

      let distributions: readonly LookaheadDistribution[];
      let cacheStatus: "hit" | "miss" | "skipped";
      let cachedComputedAtIso: string | null = null;

      if (options.noCache) {
        distributions = await summarizeLookaheadDistributions(db, {
          symbol,
          timeframe,
          sources,
          metrics,
        });
        cacheStatus = "skipped";
      } else {
        const cached = await readDistributionsCache(cachePath);
        if (cached !== null && fingerprintsMatch(cached.fingerprint, fingerprint)) {
          distributions = cached.distributions;
          cacheStatus = "hit";
          cachedComputedAtIso = cached.computedAtIso;
        } else {
          distributions = await summarizeLookaheadDistributions(db, {
            symbol,
            timeframe,
            sources,
            metrics,
          });
          cacheStatus = "miss";
          await writeDistributionsCache(cachePath, {
            version: 1,
            fingerprint,
            computedAtIso: new Date().toISOString(),
            request: { symbol, timeframe, sources, metrics },
            distributions,
          });
        }
      }

      if (options.json) {
        io.writeStdout(
          `${JSON.stringify(
            {
              symbol,
              timeframe,
              sources,
              metrics,
              cacheStatus,
              cacheComputedAtIso: cachedComputedAtIso,
              cachePath,
              fingerprint,
              distributions,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      io.writeStdout(
        formatHumanReport({
          symbol,
          timeframe,
          distributions,
          useColor,
          cacheStatus,
          cachedComputedAtIso,
          cachePath,
          fingerprint,
        }),
      );
    } finally {
      await destroyDatabase(db);
    }
  },
});

const ANSI = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
} as const;

function bold(text: string, useColor: boolean): string {
  return useColor ? `${ANSI.bold}${text}${ANSI.reset}` : text;
}

function dim(text: string, useColor: boolean): string {
  return useColor ? `${ANSI.dim}${text}${ANSI.reset}` : text;
}

/**
 * Renders the full human-readable report: a small preamble (symbol /
 * timeframe / units / cache state) followed by one section per metric,
 * each with a bolded title, a dimmed one-line description, a bolded
 * column header row, and rows grouped by exchange (separated by a
 * blank line for visual chunking).
 */
function formatHumanReport(args: {
  symbol: string;
  timeframe: Timeframe;
  distributions: readonly LookaheadDistribution[];
  useColor: boolean;
  cacheStatus: "hit" | "miss" | "skipped";
  cachedComputedAtIso: string | null;
  cachePath: string;
  fingerprint: LookaheadFingerprint;
}): string {
  const lines: string[] = [];
  lines.push(`symbol:    ${args.symbol}`);
  lines.push(`timeframe: ${args.timeframe}`);
  lines.push("units:     basis points (1 bps = 0.01%)");
  lines.push(`rows:      ${args.fingerprint.rowCount.toLocaleString("en-US")}`);
  lines.push(formatCacheLine(args, args.useColor));
  lines.push("");

  if (args.distributions.length === 0) {
    lines.push("(no metrics selected)");
    return `${lines.join("\n")}\n`;
  }

  for (const distribution of args.distributions) {
    lines.push(bold(`=== ${distribution.metric} ===`, args.useColor));
    lines.push(
      dim(
        `  ${LOOKAHEAD_METRIC_DESCRIPTIONS[distribution.metric]}`,
        args.useColor,
      ),
    );
    lines.push("");
    if (distribution.rows.length === 0) {
      lines.push("  (no rows — run `bun wiggler candles:lookahead` first)");
      lines.push("");
      continue;
    }
    lines.push(...formatDistributionTable(distribution.rows, args.useColor));
    lines.push("");
  }

  return lines.join("\n");
}

function formatCacheLine(
  args: {
    cacheStatus: "hit" | "miss" | "skipped";
    cachedComputedAtIso: string | null;
    cachePath: string;
  },
  useColor: boolean,
): string {
  switch (args.cacheStatus) {
    case "hit":
      return dim(
        `cache:     hit (${args.cachedComputedAtIso ?? "?"}, ${args.cachePath})`,
        useColor,
      );
    case "miss":
      return dim(
        `cache:     miss → wrote ${args.cachePath}`,
        useColor,
      );
    case "skipped":
      return dim("cache:     skipped (--no-cache)", useColor);
  }
}

const COLUMNS = [
  { key: "exchange", label: "exchange", align: "left" as const, width: 10 },
  { key: "lookahead", label: "lookahead", align: "right" as const, width: 9 },
  { key: "count", label: "count", align: "right" as const, width: 9 },
  { key: "mean", label: "mean", align: "right" as const, width: 7 },
  { key: "p50", label: "p50", align: "right" as const, width: 6 },
  { key: "p75", label: "p75", align: "right" as const, width: 6 },
  { key: "p80", label: "p80", align: "right" as const, width: 6 },
  { key: "p90", label: "p90", align: "right" as const, width: 6 },
  { key: "p95", label: "p95", align: "right" as const, width: 6 },
  { key: "p97_5", label: "p97.5", align: "right" as const, width: 7 },
  { key: "p99", label: "p99", align: "right" as const, width: 6 },
  { key: "p99_5", label: "p99.5", align: "right" as const, width: 7 },
  { key: "max", label: "max", align: "right" as const, width: 8 },
] as const;

/**
 * Renders one metric's table as space-padded fixed-width columns.
 *
 *   - Column header row is bolded (when `useColor`).
 *   - A blank line is emitted between exchanges so each (exchange,
 *     lookahead-block) reads as a visual chunk.
 *   - `vwap` is rendered as `aggregate` for consistency with how users
 *     conceptually refer to the cross-source aggregate everywhere else.
 */
function formatDistributionTable(
  rows: readonly LookaheadStatsRow[],
  useColor: boolean,
): readonly string[] {
  const out: string[] = [];
  out.push(bold(formatRow(COLUMNS.map((c) => c.label)), useColor));

  let prevSource: LookaheadSource | null = null;
  for (const row of rows) {
    if (prevSource !== null && prevSource !== row.source) {
      out.push("");
    }
    out.push(
      formatRow([
        renderExchange(row.source),
        `${row.lookaheadMin}m`,
        row.count.toLocaleString("en-US"),
        String(row.mean),
        String(row.p50),
        String(row.p75),
        String(row.p80),
        String(row.p90),
        String(row.p95),
        String(row.p97_5),
        String(row.p99),
        String(row.p99_5),
        String(row.max),
      ]),
    );
    prevSource = row.source;
  }
  return out;
}

function formatRow(values: readonly string[]): string {
  return COLUMNS.map((column, idx) => {
    const value = values[idx] ?? "";
    return column.align === "left"
      ? value.padEnd(column.width)
      : value.padStart(column.width);
  }).join("  ");
}

function renderExchange(source: LookaheadSource): string {
  return source === "vwap" ? "aggregate" : source;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function validateSources(values: readonly string[]): readonly LookaheadSource[] {
  const allowed = new Set<string>(LOOKAHEAD_SOURCES);
  // Friendly alias: accept `aggregate` as a synonym for `vwap` since
  // that's how the report renders it.
  const aliases: Record<string, LookaheadSource> = { aggregate: "vwap" };
  const out: LookaheadSource[] = [];
  for (const v of values) {
    const lower = v.toLowerCase();
    const resolved = aliases[lower] ?? lower;
    if (!allowed.has(resolved)) {
      throw new CliUsageError(
        `unknown source: ${v}. Supported: ${LOOKAHEAD_SOURCES.join(", ")} (or 'aggregate').`,
      );
    }
    out.push(resolved as LookaheadSource);
  }
  return out;
}

function validateMetrics(values: readonly string[]): readonly LookaheadMetric[] {
  const allowed = new Set<string>(LOOKAHEAD_METRICS);
  const out: LookaheadMetric[] = [];
  for (const v of values) {
    if (!allowed.has(v)) {
      throw new CliUsageError(
        `unknown metric: ${v}. Supported: ${LOOKAHEAD_METRICS.join(", ")}.`,
      );
    }
    out.push(v as LookaheadMetric);
  }
  return out;
}
