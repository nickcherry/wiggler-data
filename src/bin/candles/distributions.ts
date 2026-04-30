import { type Timeframe, TIMEFRAMES } from "@wiggler/constants/candles";
import { env } from "@wiggler/constants/env";
import {
  LOOKAHEAD_SOURCES,
  type LookaheadSource,
} from "@wiggler/lib/candles/lookahead";
import {
  LOOKAHEAD_METRICS,
  type LookaheadDistribution,
  type LookaheadMetric,
  type LookaheadStatsRow,
  summarizeLookaheadDistributions,
} from "@wiggler/lib/candles/lookaheadStats";
import { defineCommand, defineFlagOption, defineValueOption } from "@wiggler/lib/cli";
import { CliUsageError } from "@wiggler/lib/cli/parser";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { z } from "zod";

/**
 * Reports percentile distributions of lookahead-feature metrics from
 * `candle_lookahead_features`, grouped by `(source, lookahead_min)`.
 * One table per metric.
 *
 * Computes the stats live via `PERCENTILE_CONT` on the indexed table —
 * runs in well under a second for the full 12.7M-row corpus.
 *
 * Renders `vwap` as `aggregate` in human-readable mode, since users
 * conceptually think of it as "the cross-source aggregate" rather than
 * a raw exchange.
 */
export const candlesDistributionsCommand = defineCommand({
  name: "candles:distributions",
  summary: "Print percentile distributions of lookahead features per (source, lookahead)",
  description:
    "Reads `candle_lookahead_features` and prints a percentile-distribution table for each requested metric (max_abs_excursion_bps, close_to_close_abs_return_bps, range_bps, max_up_move_bps, max_down_move_bps), grouped by exchange and lookahead horizon. All values are basis points (1 bps = 0.01%). Run `bun wiggler candles:lookahead` first to populate the source table.",
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
  ],
  examples: [
    "bun wiggler candles:distributions",
    "bun wiggler candles:distributions --metrics max_abs_excursion_bps",
    "bun wiggler candles:distributions --sources coinbase,vwap",
    "bun wiggler candles:distributions --json",
  ],
  output:
    "Prints one percentile table per metric, with rows per (exchange, lookahead). Or JSON when --json is set.",
  sideEffects: "Reads PostgreSQL only. No external network calls.",
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

    const db = createDatabase();
    try {
      const distributions = await summarizeLookaheadDistributions(db, {
        symbol,
        timeframe,
        sources,
        metrics,
      });

      if (options.json) {
        io.writeStdout(
          `${JSON.stringify(
            { symbol, timeframe, sources, metrics, distributions },
            null,
            2,
          )}\n`,
        );
        return;
      }

      io.writeStdout(formatHumanReport({ symbol, timeframe, distributions }));
    } finally {
      await destroyDatabase(db);
    }
  },
});

/**
 * Renders the full human-readable report: one table per metric, plus a
 * one-line preamble describing what's being summarized.
 */
function formatHumanReport(args: {
  symbol: string;
  timeframe: Timeframe;
  distributions: readonly LookaheadDistribution[];
}): string {
  const lines: string[] = [];
  lines.push(`symbol:    ${args.symbol}`);
  lines.push(`timeframe: ${args.timeframe}`);
  lines.push("units:     basis points (1 bps = 0.01%)");
  lines.push("");

  if (args.distributions.length === 0) {
    lines.push("(no metrics selected)");
    return `${lines.join("\n")}\n`;
  }

  for (const distribution of args.distributions) {
    lines.push(`=== ${distribution.metric} ===`);
    if (distribution.rows.length === 0) {
      lines.push("  (no rows — run `bun wiggler candles:lookahead` first)");
      lines.push("");
      continue;
    }
    lines.push(...formatDistributionTable(distribution.rows));
    lines.push("");
  }

  return lines.join("\n");
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
 * Renders one metric's table as space-padded fixed-width columns. Rows
 * are already returned in `(source, lookaheadMin)` order from SQL; we
 * additionally collapse `vwap` → `aggregate` for display so users
 * reading the report see the conceptual name we use everywhere else
 * in this CLI.
 */
function formatDistributionTable(
  rows: readonly LookaheadStatsRow[],
): readonly string[] {
  const out: string[] = [];
  out.push(formatRow(COLUMNS.map((c) => c.label)));

  for (const row of rows) {
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
