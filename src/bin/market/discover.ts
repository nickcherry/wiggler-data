import { env } from "@wiggler/constants/env";
import { defineCommand, defineFlagOption, defineValueOption } from "@wiggler/lib/cli";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { discoverUpDownMarkets } from "@wiggler/lib/polymarket/marketDiscovery";
import { upsertMarket } from "@wiggler/lib/polymarket/upsertMarket";
import { z } from "zod";

/**
 * Discovers a sliding range of Up/Down markets for the given asset and
 * upserts the parsed results into Postgres. Lookback/lookahead let callers
 * backfill or pre-seed upcoming windows.
 */
export const marketDiscoverCommand = defineCommand({
  name: "market:discover",
  summary: "Discover and upsert Up/Down markets across a window range",
  description:
    "Walks 5-minute windows around now, fetches matching Polymarket events, and stores parsed metadata.",
  options: [
    defineValueOption({
      key: "asset",
      long: "--asset",
      valueName: "SYMBOL",
      schema: z.string().default(env.defaultAsset),
    }),
    defineValueOption({
      key: "lookback",
      long: "--lookback",
      valueName: "COUNT",
      schema: z.coerce.number().int().min(0).max(120).default(2),
    }),
    defineValueOption({
      key: "lookahead",
      long: "--lookahead",
      valueName: "COUNT",
      schema: z.coerce.number().int().min(0).max(120).default(3),
    }),
    defineFlagOption({
      key: "dryRun",
      long: "--dry-run",
      schema: z.boolean().default(false),
    }),
    defineFlagOption({
      key: "json",
      long: "--json",
      schema: z.boolean().default(false),
    }),
  ],
  examples: [
    "bun wiggler market:discover --asset BTC --lookahead 3 --lookback 3",
    "bun wiggler market:discover --asset BTC --dry-run --lookahead 1",
  ],
  output:
    "Prints the per-window discovery status and how many markets were upserted.",
  sideEffects: "Reads Gamma and writes to PostgreSQL unless --dry-run is set.",
  async run({ io, options }) {
    const assetSymbol = options.asset.toUpperCase();
    const results = await discoverUpDownMarkets({
      assetSymbol,
      lookback: options.lookback,
      lookahead: options.lookahead,
    });

    let upserted = 0;
    if (!options.dryRun) {
      const db = createDatabase();
      try {
        for (const result of results) {
          if (result.status === "ok" && result.market) {
            await upsertMarket(db, result.market);
            upserted += 1;
          }
        }
      } finally {
        await destroyDatabase(db);
      }
    }

    if (options.json) {
      io.writeStdout(
        `${JSON.stringify(
          {
            asset: assetSymbol,
            dryRun: options.dryRun,
            upserted,
            results: results.map((r) => ({
              slug: r.slug,
              status: r.status,
              startTs: new Date(r.window.startMs).toISOString(),
              detail: r.detail ?? null,
              market: r.market,
            })),
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    const lines: string[] = [];
    lines.push(`asset: ${assetSymbol}`);
    lines.push(`mode: ${options.dryRun ? "dry-run" : "live"}`);
    lines.push(`windows: ${results.length}`);
    for (const result of results) {
      const ts = new Date(result.window.startMs).toISOString();
      const detail = result.detail ? ` (${result.detail})` : "";
      lines.push(`  ${ts}  ${result.slug}  ${result.status}${detail}`);
    }
    lines.push(`upserted: ${upserted}`);
    io.writeStdout(`${lines.join("\n")}\n`);
  },
});
