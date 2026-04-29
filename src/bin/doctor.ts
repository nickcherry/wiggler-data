import { env } from "@wiggler/constants/env";
import { defineCommand, defineFlagOption } from "@wiggler/lib/cli";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { getFiveMinuteWindow } from "@wiggler/lib/domain/marketWindow";
import { fetchGammaEventBySlug } from "@wiggler/lib/polymarket/gammaClient";
import { buildUpDownSlugFromWindow } from "@wiggler/lib/polymarket/slug";
import { sql } from "kysely";
import { z } from "zod";

/**
 * Sanity-checks the runtime environment: env vars, DB connectivity, Gamma reachability.
 */
export const doctorCommand = defineCommand({
  name: "doctor",
  summary: "Run a runtime health check",
  description:
    "Verifies env vars, database connectivity, migration state, and Polymarket Gamma reachability.",
  options: [
    defineFlagOption({
      key: "json",
      long: "--json",
      schema: z.boolean().default(false),
    }),
  ],
  examples: ["bun wiggler doctor"],
  output: "Prints status checks for the local environment.",
  sideEffects: "Connects to PostgreSQL and Gamma briefly.",
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
      name: "env.gammaBaseUrl",
      status: "ok",
      detail: env.gammaBaseUrl,
    });
    checks.push({
      name: "env.polymarketWsUrl",
      status: "ok",
      detail: env.polymarketWsUrl,
    });
    checks.push({
      name: "env.coinbaseWsUrl",
      status: "ok",
      detail: env.coinbaseWsUrl,
    });
    checks.push({
      name: "env.binanceWsUrl",
      status: "ok",
      detail: env.binanceWsUrl,
    });
    checks.push({
      name: "env.geminiWsBaseUrl",
      status: "ok",
      detail: env.geminiWsBaseUrl,
    });
    checks.push({
      name: "env.bybitWsUrl",
      status: "ok",
      detail: env.bybitWsUrl,
    });
    checks.push({
      name: "env.bitstampWsUrl",
      status: "ok",
      detail: env.bitstampWsUrl,
    });
    checks.push({
      name: "env.bitfinexWsUrl",
      status: "ok",
      detail: env.bitfinexWsUrl,
    });
    checks.push({
      name: "env.krakenWsUrl",
      status: "ok",
      detail: env.krakenWsUrl,
    });
    checks.push({
      name: "env.priceSymbols",
      status: "ok",
      detail: env.priceSymbols.join(","),
    });

    let dbStatus: "ok" | "warn" | "fail" = "fail";
    let dbDetail = "unknown";
    const db = createDatabase();
    try {
      await sql`select 1`.execute(db);
      dbStatus = "ok";
      dbDetail = "connected";
      const tables = await sql<{ table_name: string }>`
        select table_name from information_schema.tables
        where table_schema = 'public' and table_name in ('markets','book_snapshots','book_levels','asset_price_snapshots')
      `.execute(db);
      const tableSet = new Set(tables.rows.map((r) => r.table_name));
      const required = ["markets", "book_snapshots", "book_levels", "asset_price_snapshots"];
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

    let gammaStatus: "ok" | "warn" | "fail" = "fail";
    let gammaDetail = "unknown";
    try {
      const probeSlug = buildUpDownSlugFromWindow(env.defaultAsset, getFiveMinuteWindow());
      const result = await fetchGammaEventBySlug(probeSlug);
      if (result.status === "ok") {
        gammaStatus = "ok";
        gammaDetail = `reachable; current slug ${probeSlug} resolved`;
      } else if (result.status === "not_found") {
        gammaStatus = "warn";
        gammaDetail = `reachable; current slug ${probeSlug} not found yet`;
      } else {
        gammaStatus = "fail";
        gammaDetail = `error ${result.httpStatus}`;
      }
    } catch (error) {
      gammaStatus = "fail";
      gammaDetail = error instanceof Error ? error.message : String(error);
    }
    checks.push({ name: "polymarket.gamma", status: gammaStatus, detail: gammaDetail });

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

function maskDatabaseUrl(url: string): string {
  return url.replace(/:[^:@/]+@/, ":***@");
}
