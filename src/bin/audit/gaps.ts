import { env } from "@wiggler/constants/env";
import { FIVE_MINUTE_MS } from "@wiggler/constants/markets";
import { defineCommand, defineFlagOption, defineValueOption } from "@wiggler/lib/cli";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { getFiveMinuteWindow } from "@wiggler/lib/domain/marketWindow";
import { listMarketsByWindow } from "@wiggler/lib/polymarket/queries/markets";
import { buildUpDownSlugFromWindow } from "@wiggler/lib/polymarket/slug";
import { parseDurationMs } from "@wiggler/lib/time/durations";
import { z } from "zod";

/**
 * Detects missing 5-minute windows and missing token IDs in the markets table.
 */
export const auditGapsCommand = defineCommand({
  name: "audit:gaps",
  summary: "Detect gaps in markets and snapshot coverage",
  description:
    "Walks 5-minute windows over the lookback range and flags missing markets, missing token IDs, and unparseable rows.",
  options: [
    defineValueOption({
      key: "asset",
      long: "--asset",
      valueName: "SYMBOL",
      schema: z.string().default(env.defaultAsset),
    }),
    defineValueOption({
      key: "since",
      long: "--since",
      valueName: "DURATION",
      schema: z.string().default("24h"),
    }),
    defineFlagOption({
      key: "json",
      long: "--json",
      schema: z.boolean().default(false),
    }),
  ],
  examples: ["bun wiggler audit:gaps --asset BTC --since 24h"],
  output: "Prints gap audit text or JSON.",
  sideEffects: "Reads PostgreSQL only.",
  async run({ io, options }) {
    const db = createDatabase();
    try {
      const assetSymbol = options.asset.toUpperCase();
      const sinceMs = parseDurationMs(options.since);
      const nowMs = Date.now();
      const currentWindow = getFiveMinuteWindow(nowMs);
      const fromMs = currentWindow.startMs - sinceMs;
      const toMs = currentWindow.startMs;

      const expectedSlugs = buildExpectedSlugs(assetSymbol, fromMs, toMs);
      const rows = await listMarketsByWindow(db, {
        assetSymbol,
        fromMs,
        toMs,
      });
      const presentBySlug = new Map(rows.map((row) => [row.slug, row]));

      const missingMarkets: string[] = [];
      const missingUpTokens: string[] = [];
      const missingDownTokens: string[] = [];
      const missingConditionIds: string[] = [];

      for (const slug of expectedSlugs) {
        const row = presentBySlug.get(slug);
        if (!row) {
          missingMarkets.push(slug);
          continue;
        }
        if (!row.up_token_id) {
          missingUpTokens.push(slug);
        }
        if (!row.down_token_id) {
          missingDownTokens.push(slug);
        }
        if (!row.condition_id) {
          missingConditionIds.push(slug);
        }
      }

      const status =
        missingMarkets.length > 0 ||
        missingUpTokens.length > 0 ||
        missingDownTokens.length > 0
          ? "WARN"
          : "OK";

      if (options.json) {
        io.writeStdout(
          `${JSON.stringify(
            {
              asset: assetSymbol,
              fromTs: new Date(fromMs).toISOString(),
              toTs: new Date(toMs).toISOString(),
              expectedWindows: expectedSlugs.length,
              presentWindows: expectedSlugs.length - missingMarkets.length,
              missingMarkets,
              missingUpTokens,
              missingDownTokens,
              missingConditionIds,
              status,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      const lines = [
        `asset: ${assetSymbol}`,
        `from: ${new Date(fromMs).toISOString()}`,
        `to: ${new Date(toMs).toISOString()}`,
        `expected_windows: ${expectedSlugs.length}`,
        `present_windows: ${expectedSlugs.length - missingMarkets.length}`,
        `missing_markets: ${missingMarkets.length}`,
        `missing_up_tokens: ${missingUpTokens.length}`,
        `missing_down_tokens: ${missingDownTokens.length}`,
        `missing_condition_ids: ${missingConditionIds.length}`,
        `status: ${status}`,
      ];
      if (missingMarkets.length > 0) {
        lines.push("missing_market_slugs:");
        for (const slug of missingMarkets.slice(0, 20)) {
          lines.push(`  ${slug}`);
        }
        if (missingMarkets.length > 20) {
          lines.push(`  ... +${missingMarkets.length - 20} more`);
        }
      }
      io.writeStdout(`${lines.join("\n")}\n`);
    } finally {
      await destroyDatabase(db);
    }
  },
});

function buildExpectedSlugs(
  assetSymbol: string,
  fromMs: number,
  toMs: number,
): readonly string[] {
  const slugs: string[] = [];
  for (let cursor = fromMs; cursor < toMs; cursor += FIVE_MINUTE_MS) {
    slugs.push(
      buildUpDownSlugFromWindow(assetSymbol, {
        startMs: cursor,
        endMs: cursor + FIVE_MINUTE_MS,
      }),
    );
  }
  return slugs;
}
