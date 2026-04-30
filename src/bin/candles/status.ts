import { summarizeCandleCoverage } from "@wiggler/lib/candles/queries";
import { defineCommand, defineFlagOption } from "@wiggler/lib/cli";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { z } from "zod";

/**
 * Reports per-(source, symbol, timeframe) coverage: how many candles, the
 * earliest / latest open_time, and how stale the latest is. Useful before
 * running an analysis to confirm every series has the data you expect.
 */
export const candlesStatusCommand = defineCommand({
  name: "candles:status",
  summary: "Report candle coverage per (source, symbol, timeframe)",
  description:
    "For every (source, symbol, timeframe) we have any candles for, prints total row count, earliest open_time, latest open_time, and how stale the latest is relative to now.",
  options: [
    defineFlagOption({
      key: "json",
      long: "--json",
      schema: z.boolean().default(false),
    }),
  ],
  examples: ["bun wiggler candles:status"],
  output: "Prints a table (or JSON) of per-series coverage.",
  sideEffects: "Reads PostgreSQL only.",
  async run({ io, options }) {
    const db = createDatabase();
    try {
      const rows = await summarizeCandleCoverage(db);
      const nowMs = Date.now();
      if (options.json) {
        io.writeStdout(
          `${JSON.stringify(
            rows.map((r) => ({
              source: r.source,
              symbol: r.symbol,
              timeframe: r.timeframe,
              total: r.total,
              earliest: r.earliestMs !== null ? new Date(r.earliestMs).toISOString() : null,
              latest: r.latestMs !== null ? new Date(r.latestMs).toISOString() : null,
              ageMs: r.latestMs !== null ? nowMs - r.latestMs : null,
            })),
            null,
            2,
          )}\n`,
        );
        return;
      }
      const lines: string[] = [
        "source     symbol  tf    rows           earliest                  latest                    age",
      ];
      if (rows.length === 0) {
        lines.push("(no candles synced yet — run `bun wiggler candles:sync`)");
      }
      for (const r of rows) {
        const earliest = r.earliestMs !== null ? new Date(r.earliestMs).toISOString() : "n/a";
        const latest = r.latestMs !== null ? new Date(r.latestMs).toISOString() : "n/a";
        const age = r.latestMs !== null ? formatAge(nowMs - r.latestMs) : "n/a";
        lines.push(
          `${r.source.padEnd(10)} ${r.symbol.padEnd(6)}  ${r.timeframe.padEnd(4)}  ${String(r.total).padStart(11)}    ${earliest}  ${latest}  ${age}`,
        );
      }
      io.writeStdout(`${lines.join("\n")}\n`);
    } finally {
      await destroyDatabase(db);
    }
  },
});

function formatAge(ms: number): string {
  if (ms < 60_000) {
    return `${Math.round(ms / 1000)}s`;
  }
  if (ms < 3_600_000) {
    return `${(ms / 60_000).toFixed(1)}m`;
  }
  if (ms < 86_400_000) {
    return `${(ms / 3_600_000).toFixed(1)}h`;
  }
  return `${(ms / 86_400_000).toFixed(1)}d`;
}
