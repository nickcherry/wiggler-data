import { CANDLE_SOURCES } from "@wiggler/constants/candles";
import { env } from "@wiggler/constants/env";
import { defineCommand, defineFlagOption } from "@wiggler/lib/cli";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { sql } from "kysely";
import { z } from "zod";

/**
 * Sanity-checks the runtime environment before running a sync: env vars,
 * database connectivity, schema state, and CEX REST reachability for
 * every configured source.
 */
export const doctorCommand = defineCommand({
  name: "doctor",
  summary: "Run a runtime health check",
  description:
    "Verifies env vars, database connectivity, migration state, and CEX REST endpoint reachability.",
  options: [
    defineFlagOption({
      key: "json",
      long: "--json",
      schema: z.boolean().default(false),
    }),
  ],
  examples: ["bun wiggler doctor"],
  output: "Prints status checks for the local environment.",
  sideEffects: "Connects to PostgreSQL and probes every CEX REST endpoint with a HEAD request.",
  async run({ io, options }) {
    const checks: Array<{
      name: string;
      status: "ok" | "warn" | "fail";
      detail: string;
    }> = [];

    checks.push({
      name: "env.databaseUrl",
      status: env.databaseUrl ? "ok" : "fail",
      detail: env.databaseUrl ? maskDatabaseUrl(env.databaseUrl) : "missing",
    });
    checks.push({
      name: "env.defaultSymbols",
      status: "ok",
      detail: env.defaultSymbols.join(","),
    });
    for (const source of CANDLE_SOURCES) {
      checks.push({
        name: `env.${source}RestBaseUrl`,
        status: "ok",
        detail: restBaseUrlFor(source),
      });
    }

    let dbStatus: "ok" | "warn" | "fail" = "fail";
    let dbDetail = "unknown";
    const db = createDatabase();
    try {
      await sql`select 1`.execute(db);
      dbStatus = "ok";
      dbDetail = "connected";
      const tables = await sql<{ table_name: string }>`
        select table_name from information_schema.tables
        where table_schema = 'public' and table_name in ('candles','candle_sync_runs')
      `.execute(db);
      const tableSet = new Set(tables.rows.map((r) => r.table_name));
      const required = ["candles", "candle_sync_runs"];
      const missing = required.filter((t) => !tableSet.has(t));
      if (missing.length > 0) {
        dbStatus = "warn";
        dbDetail = `connected; missing tables: ${missing.join(", ")} (run db:migrate)`;
      }
    } catch (error) {
      dbStatus = "fail";
      dbDetail = error instanceof Error ? error.message : String(error);
    } finally {
      await destroyDatabase(db);
    }
    checks.push({ name: "db.connection", status: dbStatus, detail: dbDetail });

    for (const source of CANDLE_SOURCES) {
      const url = restBaseUrlFor(source);
      try {
        const response = await fetch(url, { method: "HEAD" });
        checks.push({
          name: `rest.${source}`,
          status: response.status >= 200 && response.status < 500 ? "ok" : "warn",
          detail: `HEAD ${url} → ${response.status}`,
        });
      } catch (error) {
        checks.push({
          name: `rest.${source}`,
          status: "fail",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const overall: "ok" | "warn" | "fail" = checks.some((c) => c.status === "fail")
      ? "fail"
      : checks.some((c) => c.status === "warn")
        ? "warn"
        : "ok";

    if (options.json) {
      io.writeStdout(`${JSON.stringify({ overall, checks }, null, 2)}\n`);
    } else {
      const lines: string[] = ["wiggler doctor"];
      for (const check of checks) {
        lines.push(`  ${check.status.padEnd(4)} ${check.name.padEnd(28)} ${check.detail}`);
      }
      lines.push(`status: ${overall}`);
      io.writeStdout(`${lines.join("\n")}\n`);
    }

    if (overall === "fail") {
      process.exitCode = 1;
    }
  },
});

function restBaseUrlFor(source: string): string {
  switch (source) {
    case "coinbase":
      return env.coinbaseRestBaseUrl;
    case "binance":
      return env.binanceRestBaseUrl;
    case "bitstamp":
      return env.bitstampRestBaseUrl;
    case "bitfinex":
      return env.bitfinexRestBaseUrl;
    default:
      return "(unknown source)";
  }
}

function maskDatabaseUrl(url: string): string {
  return url.replace(/:[^:@/]+@/, ":***@");
}
