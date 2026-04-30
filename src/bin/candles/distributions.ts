import { type Timeframe, TIMEFRAMES } from "@wiggler/constants/candles";
import { env } from "@wiggler/constants/env";
import {
  LOOKAHEAD_SOURCES,
  type LookaheadSource,
} from "@wiggler/lib/candles/lookahead";
import {
  getLookaheadFingerprint,
  LOOKAHEAD_METRIC_DESCRIPTIONS,
  LOOKAHEAD_METRICS,
  type LookaheadFingerprint,
  type LookaheadMetric,
  type LookaheadStatsRow,
} from "@wiggler/lib/candles/lookaheadStats";
import {
  loadDistributionsWithCache,
  metricCachePath,
  type MetricCacheStatus,
} from "@wiggler/lib/candles/lookaheadStatsCache";
import { defineCommand, defineFlagOption, defineValueOption } from "@wiggler/lib/cli";
import { CliUsageError } from "@wiggler/lib/cli/parser";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { z } from "zod";

/**
 * Reports percentile distributions of lookahead-feature metrics from
 * `candle_lookahead_features`, grouped by `(source, lookahead_min)`.
 * One table per metric, each preceded by a one-line description and a
 * dim cache-state line.
 *
 * Caching is per-metric: each metric has its own JSON file at
 * `tmp/distributions/{SYMBOL}_{TF}/{metric}.json`. Tweaking or adding
 * one metric only invalidates that one file; changing `--sources`
 * filters reuses the same cache files (filtering is client-side).
 *
 * Renders `vwap` as `aggregate` in human-readable mode, since users
 * conceptually think of it as "the cross-source aggregate" rather than
 * a raw exchange. Bolds metric titles + column headings and dims the
 * description / cache-state lines when stdout is a TTY (suppressed by
 * `--no-color` or when piping into a file).
 */
export const candlesDistributionsCommand = defineCommand({
  name: "candles:distributions",
  summary: "Print percentile distributions of lookahead features per (source, lookahead)",
  description:
    "Reads `candle_lookahead_features` and prints a percentile-distribution table for each requested metric (max_abs_excursion_bps, close_to_close_abs_return_bps, range_bps, max_up_move_bps, max_down_move_bps), grouped by exchange and lookahead horizon. All values are basis points (1 bps = 0.01%). Run `bun wiggler candles:lookahead` first to populate the source table. Each metric is cached independently to `tmp/distributions/{SYMBOL}_{TF}/{metric}.json` and reused when the underlying data hasn't changed.",
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
    "Reads PostgreSQL. Reads/writes per-metric JSON cache files under `tmp/distributions/{SYMBOL}_{TF}/` unless --no-cache is set.",
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
      const fingerprint = await getLookaheadFingerprint(db, { symbol, timeframe });
      const { distributions, cacheStatus } = await loadDistributionsWithCache(db, {
        symbol,
        timeframe,
        metrics,
        sources,
        fingerprint,
        useCache: !options.noCache,
      });

      if (options.json) {
        io.writeStdout(
          `${JSON.stringify(
            {
              symbol,
              timeframe,
              sources,
              metrics,
              fingerprint,
              cacheStatusByMetric: Object.fromEntries(cacheStatus),
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
          cacheStatus,
          fingerprint,
          useColor,
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
 * Renders the full human-readable report: a small preamble followed
 * by one section per metric — bold title, dim description + cache
 * state, bold column header, rows grouped by exchange (with a blank
 * line between exchanges).
 */
function formatHumanReport(args: {
  symbol: string;
  timeframe: Timeframe;
  distributions: ReturnType<typeof loadDistributionsWithCache> extends Promise<{
    distributions: infer D;
    cacheStatus: unknown;
  }>
    ? D
    : never;
  cacheStatus: ReadonlyMap<LookaheadMetric, MetricCacheStatus>;
  fingerprint: LookaheadFingerprint;
  useColor: boolean;
}): string {
  const lines: string[] = [];
  lines.push(`symbol:    ${args.symbol}`);
  lines.push(`timeframe: ${args.timeframe}`);
  lines.push("units:     basis points (1 bps = 0.01%)");
  lines.push(`rows:      ${args.fingerprint.rowCount.toLocaleString("en-US")}`);
  lines.push(formatGlobalCacheLine(args.cacheStatus, args.useColor));
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
    const status = args.cacheStatus.get(distribution.metric);
    if (status !== undefined) {
      lines.push(
        dim(
          `  ${formatPerMetricCacheLine(distribution.metric, status, args.symbol, args.timeframe)}`,
          args.useColor,
        ),
      );
    }
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

/**
 * Compact one-line summary of cache outcomes across all requested
 * metrics: e.g. "cache: 4 hits, 1 miss" or "cache: bypassed (--no-cache)".
 */
function formatGlobalCacheLine(
  status: ReadonlyMap<LookaheadMetric, MetricCacheStatus>,
  useColor: boolean,
): string {
  let hits = 0;
  let misses = 0;
  let skipped = 0;
  for (const value of status.values()) {
    if (value.status === "hit") {
      hits++;
    } else if (value.status === "miss") {
      misses++;
    } else {
      skipped++;
    }
  }
  if (skipped > 0 && hits === 0 && misses === 0) {
    return dim("cache:     bypassed (--no-cache)", useColor);
  }
  const parts: string[] = [];
  if (hits > 0) {
    parts.push(`${hits} ${plural("hit", hits)}`);
  }
  if (misses > 0) {
    parts.push(`${misses} ${plural("miss", misses, "misses")}`);
  }
  if (skipped > 0) {
    parts.push(`${skipped} skipped`);
  }
  return dim(`cache:     ${parts.join(", ")}`, useColor);
}

function plural(singular: string, n: number, pluralForm?: string): string {
  if (n === 1) {
    return singular;
  }
  return pluralForm ?? `${singular}s`;
}

/**
 * Per-metric cache status line shown under each section heading.
 * Includes the cache file path so the user can `cat` / `rm` it
 * directly when iterating.
 */
function formatPerMetricCacheLine(
  metric: LookaheadMetric,
  status: MetricCacheStatus,
  symbol: string,
  timeframe: Timeframe,
): string {
  const path = metricCachePath({ symbol, timeframe, metric });
  switch (status.status) {
    case "hit":
      return `cache hit (${status.computedAtIso}, ${path})`;
    case "miss":
      return `cache miss → recomputed and wrote ${path}`;
    case "skipped":
      return "cache bypassed (--no-cache)";
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
