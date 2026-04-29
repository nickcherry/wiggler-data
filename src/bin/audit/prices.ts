import { env } from "@wiggler/constants/env";
import { ageFrom } from "@wiggler/lib/audit/freshness";
import { defineCommand, defineFlagOption, defineValueOption } from "@wiggler/lib/cli";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import type { AssetPriceSnapshotsTable } from "@wiggler/lib/db/types";
import { fromScaledInt } from "@wiggler/lib/domain/decimal";
import { PRICE_SOURCES, type PriceSource } from "@wiggler/lib/prices/types";
import { parseDurationMs } from "@wiggler/lib/time/durations";
import { z } from "zod";

const PRICE_SCALE = 100_000_000;

/**
 * Audits CEX asset price ingestion. In the snapshot-only model, "are the
 * price feeds healthy?" reduces to "are `asset_price_snapshots` rows being
 * written on schedule, with non-null per-source midpoints?" — the per-source
 * `*_age_ms` columns capture how stale each feed was at snapshot time.
 */
export const auditPricesCommand = defineCommand({
  name: "audit:prices",
  summary: "Audit CEX asset price snapshot ingestion",
  description:
    "Reports total price snapshots in the lookback window, the latest per-source midpoints, and per-source staleness at the most recent snapshot.",
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
      schema: z.string().default("1h"),
    }),
    defineFlagOption({
      key: "json",
      long: "--json",
      schema: z.boolean().default(false),
    }),
  ],
  examples: [
    "bun wiggler audit:prices --asset BTC --since 1h",
    "bun wiggler audit:prices --asset BTC --since 24h --json",
  ],
  output: "Prints summary text or JSON.",
  sideEffects: "Reads PostgreSQL only.",
  async run({ io, options }) {
    const db = createDatabase();
    try {
      const symbol = options.asset.toUpperCase();
      const sinceMs = parseDurationMs(options.since);
      const nowMs = Date.now();

      const summary = await db
        .selectFrom("asset_price_snapshots")
        .select((eb) => [
          eb.fn.countAll<string>().as("total"),
          eb.fn.max("captured_at").as("last_at"),
          eb.fn.min("captured_at").as("first_at"),
          eb.fn.max("blended_mid_e8").as("max_blended"),
          eb.fn.min("blended_mid_e8").as("min_blended"),
        ])
        .where("symbol", "=", symbol)
        .where("captured_at", ">=", new Date(nowMs - sinceMs))
        .executeTakeFirst();

      const latest = await db
        .selectFrom("asset_price_snapshots")
        .selectAll()
        .where("symbol", "=", symbol)
        .orderBy("captured_at", "desc")
        .limit(1)
        .executeTakeFirst();

      const total = summary ? Number(summary.total ?? 0) : 0;
      const lastAt = (summary?.last_at as Date | null | undefined) ?? null;
      const freshness = ageFrom(lastAt, nowMs);

      if (options.json) {
        const sourcesJson: Record<string, unknown> = {};
        if (latest) {
          for (const source of PRICE_SOURCES) {
            sourcesJson[source] = {
              mid: latestMidNumber(latest, source),
              ageMs: latestAgeMs(latest, source),
            };
          }
        }
        io.writeStdout(
          `${JSON.stringify(
            {
              asset: symbol,
              since: options.since,
              total,
              firstAt: (summary?.first_at as Date | null | undefined)?.toISOString() ?? null,
              lastAt: lastAt?.toISOString() ?? null,
              lastAgeMs: freshness.ageMs,
              minBlended: summary?.min_blended
                ? fromScaledInt(BigInt(summary.min_blended), PRICE_SCALE)
                : null,
              maxBlended: summary?.max_blended
                ? fromScaledInt(BigInt(summary.max_blended), PRICE_SCALE)
                : null,
              latest: latest
                ? {
                    capturedAt: latest.captured_at.toISOString(),
                    blended: latest.blended_mid_e8
                      ? fromScaledInt(BigInt(latest.blended_mid_e8), PRICE_SCALE)
                      : null,
                    sources: sourcesJson,
                    sourceCount: latest.source_count,
                  }
                : null,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      const lines: string[] = [];
      lines.push(`asset: ${symbol}`);
      lines.push(`since: ${options.since}`);
      lines.push(`snapshots_in_window: ${total}`);
      lines.push(`last_snapshot_age: ${freshness.display}`);
      if (summary?.min_blended && summary.max_blended) {
        const min = fromScaledInt(BigInt(summary.min_blended), PRICE_SCALE);
        const max = fromScaledInt(BigInt(summary.max_blended), PRICE_SCALE);
        lines.push(`blended_range: ${min}..${max}`);
      }
      if (latest) {
        const blended = latest.blended_mid_e8
          ? fromScaledInt(BigInt(latest.blended_mid_e8), PRICE_SCALE)
          : "n/a";
        lines.push("latest_snapshot:");
        lines.push(`  captured_at: ${latest.captured_at.toISOString()}`);
        lines.push(`  blended_mid: ${blended}`);
        lines.push(`  source_count: ${latest.source_count}`);
        for (const source of PRICE_SOURCES) {
          const mid = latestMidString(latest, source);
          const age = formatAgeMs(latestAgeMs(latest, source));
          lines.push(`  ${source.padEnd(8)}: ${mid}  age=${age}`);
        }
      } else {
        lines.push("latest_snapshot: (none)");
      }
      io.writeStdout(`${lines.join("\n")}\n`);
    } finally {
      await destroyDatabase(db);
    }
  },
});

type LatestRow = {
  readonly [K in keyof AssetPriceSnapshotsTable]: AssetPriceSnapshotsTable[K] extends {
    readonly __select__?: infer S;
  }
    ? S
    : unknown;
};

function latestMidRaw(row: LatestRow, source: PriceSource): string | null {
  const value = (row as unknown as Record<string, unknown>)[`${source}_mid_e8`];
  if (typeof value === "string") {return value;}
  if (typeof value === "number" || typeof value === "bigint") {return value.toString();}
  return null;
}

function latestMidNumber(row: LatestRow, source: PriceSource): string | null {
  const raw = latestMidRaw(row, source);
  return raw ? fromScaledInt(BigInt(raw), PRICE_SCALE) : null;
}

function latestMidString(row: LatestRow, source: PriceSource): string {
  return latestMidNumber(row, source) ?? "n/a";
}

function latestAgeMs(row: LatestRow, source: PriceSource): number | null {
  const value = (row as unknown as Record<string, unknown>)[`${source}_age_ms`];
  if (value === null || value === undefined) {return null;}
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatAgeMs(ageMs: number | null): string {
  if (ageMs === null) {return "n/a";}
  if (ageMs < 1000) {return `${ageMs}ms`;}
  return `${(ageMs / 1000).toFixed(1)}s`;
}
