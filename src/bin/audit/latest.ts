import { env } from "@wiggler/constants/env";
import { ageFrom } from "@wiggler/lib/audit/freshness";
import { checkComplementPrices, checkCrossed } from "@wiggler/lib/audit/validateBook";
import { defineCommand, defineFlagOption, defineValueOption } from "@wiggler/lib/cli";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { fromScaledInt } from "@wiggler/lib/domain/decimal";
import { getFiveMinuteWindow, getNextFiveMinuteWindow } from "@wiggler/lib/domain/marketWindow";
import {
  countPriceSnapshotsSince,
  countSnapshotsSince,
  listLatestSnapshotsForMarket,
} from "@wiggler/lib/polymarket/queries/audit";
import { getCurrentMarket, getMarketBySlug } from "@wiggler/lib/polymarket/queries/markets";
import { buildUpDownSlugFromWindow } from "@wiggler/lib/polymarket/slug";
import { PRICE_SOURCES, type PriceSource } from "@wiggler/lib/prices/types";
import { z } from "zod";

const FRESH_BOOK_SNAPSHOT_THRESHOLD_MS = 3_000;
const FRESH_PRICE_SNAPSHOT_THRESHOLD_MS = 3_000;

/**
 * Live freshness/integrity audit. In the snapshot-only model, "is the
 * collector healthy?" reduces to "are book snapshots and asset price
 * snapshots arriving on schedule?" — both schedulers tick at
 * `COLLECTOR_SNAPSHOT_INTERVAL_MS` (default 1s) so anything older than a
 * few cadence ticks indicates a problem.
 */
export const auditLatestCommand = defineCommand({
  name: "audit:latest",
  summary: "Audit live wiggler data freshness and integrity",
  description:
    "Checks current market discovery, latest book snapshot freshness, complement-price sanity, and the latest CEX asset price snapshot for the active 5m window.",
  options: [
    defineValueOption({
      key: "asset",
      long: "--asset",
      valueName: "SYMBOL",
      schema: z.string().default(env.defaultAsset),
    }),
    defineFlagOption({
      key: "json",
      long: "--json",
      schema: z.boolean().default(false),
    }),
  ],
  examples: ["bun wiggler audit:latest --asset BTC"],
  output: "Prints a multi-section human-readable status block (or JSON).",
  sideEffects: "Reads PostgreSQL only.",
  async run({ io, options }) {
    const db = createDatabase();
    try {
      const assetSymbol = options.asset.toUpperCase();
      const nowMs = Date.now();
      const currentWindow = getFiveMinuteWindow(nowMs);
      const nextWindow = getNextFiveMinuteWindow(nowMs);
      const currentSlug = buildUpDownSlugFromWindow(assetSymbol, currentWindow);
      const nextSlug = buildUpDownSlugFromWindow(assetSymbol, nextWindow);

      const fiveMinAgoMs = nowMs - 5 * 60 * 1000;

      const [currentRow, currentBySlug, nextBySlug, snap5m, price5m, latestPrice] =
        await Promise.all([
          getCurrentMarket(db, { assetSymbol, referenceMs: nowMs }),
          getMarketBySlug(db, currentSlug),
          getMarketBySlug(db, nextSlug),
          countSnapshotsSince(db, fiveMinAgoMs),
          countPriceSnapshotsSince(db, { sinceMs: fiveMinAgoMs, symbol: assetSymbol }),
          getLatestPriceSnapshot(db, assetSymbol),
        ]);

      const market = currentRow ?? currentBySlug;
      const latestSnapshots = market
        ? await listLatestSnapshotsForMarket(db, market.slug)
        : [];

      const upSnap = latestSnapshots.find((s) => s.outcome === "Up");
      const downSnap = latestSnapshots.find((s) => s.outcome === "Down");

      const upSummary = toSummary(upSnap);
      const downSummary = toSummary(downSnap);
      const upCrossed = checkCrossed(upSummary);
      const downCrossed = checkCrossed(downSummary);
      const complement = checkComplementPrices({ up: upSummary, down: downSummary });

      const snapFreshness = ageFrom(snap5m.lastAt, nowMs);
      const priceFreshness = ageFrom(price5m.lastAt, nowMs);

      const status = decideStatus({
        hasMarket: !!market,
        hasNext: !!nextBySlug,
        snapAgeMs: snapFreshness.ageMs,
        priceAgeMs: priceFreshness.ageMs,
        upCrossed: upCrossed.crossed,
        downCrossed: downCrossed.crossed,
        complementOk: complement.ok,
      });

      if (options.json) {
        io.writeStdout(
          `${JSON.stringify(
            {
              status,
              asset: assetSymbol,
              currentSlug,
              nextSlug,
              market,
              counts: {
                bookSnapshotsLast5m: snap5m.total,
                priceSnapshotsLast5m: price5m.total,
              },
              freshness: {
                lastBookSnapshotAgeMs: snapFreshness.ageMs,
                lastPriceSnapshotAgeMs: priceFreshness.ageMs,
              },
              complement,
              books: {
                up: snapToReport(upSnap),
                down: snapToReport(downSnap),
              },
              latestPrice,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      const lines: string[] = [];
      lines.push(`${assetSymbol} Up/Down 5m collector audit`);
      lines.push("Current market:");
      if (market) {
        lines.push(`  slug: ${market.slug}`);
        lines.push(
          `  window: ${market.start_ts.toISOString()} -> ${market.end_ts.toISOString()}`,
        );
        lines.push(`  condition_id: ${market.condition_id ?? "(none)"}`);
        lines.push(`  up_token_id: ${market.up_token_id ?? "(none)"}`);
        lines.push(`  down_token_id: ${market.down_token_id ?? "(none)"}`);
      } else {
        lines.push(`  slug: ${currentSlug}`);
        lines.push("  status: market not yet discovered");
      }
      lines.push("Next market:");
      lines.push(`  slug: ${nextSlug}`);
      lines.push(`  status: ${nextBySlug ? "discovered" : "missing"}`);

      lines.push("Polymarket book:");
      lines.push(`  last_book_snapshot_age: ${snapFreshness.display}`);
      lines.push(`  up_best_bid/ask: ${formatBidAsk(upSummary)}`);
      lines.push(`  down_best_bid/ask: ${formatBidAsk(downSummary)}`);
      lines.push(`  book_crossed_up: ${upCrossed.crossed ? "yes" : "no"}`);
      lines.push(`  book_crossed_down: ${downCrossed.crossed ? "yes" : "no"}`);
      lines.push(`  complement_check: ${complement.ok ? "ok" : "warn"} (${complement.detail})`);

      lines.push(`CEX prices (${assetSymbol}):`);
      lines.push(`  last_price_snapshot_age: ${priceFreshness.display}`);
      if (latestPrice) {
        const blended = latestPrice.blendedMidE8
          ? fromScaledInt(latestPrice.blendedMidE8, 100_000_000)
          : "n/a";
        lines.push(`  blended_mid: ${blended}  source_count: ${latestPrice.sourceCount}`);
        for (const source of PRICE_SOURCES) {
          const perSource = latestPrice.sources[source];
          const mid = perSource.midE8
            ? fromScaledInt(perSource.midE8, 100_000_000)
            : "n/a";
          lines.push(
            `  ${source.padEnd(8)}: ${mid}  age=${formatAgeMs(perSource.ageMs)}`,
          );
        }
      } else {
        lines.push("  (no asset price snapshots yet)");
      }

      lines.push("Storage:");
      lines.push(`  book_snapshots_last_5m: ${snap5m.total}`);
      lines.push(`  price_snapshots_last_5m: ${price5m.total}`);
      lines.push(`Status: ${status}`);
      io.writeStdout(`${lines.join("\n")}\n`);

      if (status === "FAIL") {
        process.exitCode = 1;
      }
    } finally {
      await destroyDatabase(db);
    }
  },
});

type LatestPerSource = Readonly<{
  midE8: bigint | null;
  ageMs: number | null;
}>;

type LatestPriceSnapshot = Readonly<{
  capturedAt: Date;
  blendedMidE8: bigint | null;
  sourceCount: number;
  sources: Readonly<Record<PriceSource, LatestPerSource>>;
}>;

async function getLatestPriceSnapshot(
  db: ReturnType<typeof createDatabase>,
  symbol: string,
): Promise<LatestPriceSnapshot | null> {
  const row = await db
    .selectFrom("asset_price_snapshots")
    .selectAll()
    .where("symbol", "=", symbol)
    .orderBy("captured_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) {
    return null;
  }
  const sources = {} as Record<PriceSource, LatestPerSource>;
  const r = row as unknown as Record<string, unknown>;
  for (const source of PRICE_SOURCES) {
    const midRaw = r[`${source}_mid_e8`];
    const ageRaw = r[`${source}_age_ms`];
    sources[source] = {
      midE8: midRaw ? BigInt(midRaw as string) : null,
      ageMs:
        ageRaw === null || ageRaw === undefined ? null : Number(ageRaw),
    };
  }
  return {
    capturedAt: row.captured_at,
    blendedMidE8: row.blended_mid_e8 ? BigInt(row.blended_mid_e8) : null,
    sourceCount: row.source_count,
    sources,
  };
}

function toSummary(
  snap:
    | {
        best_bid_e6: string | null;
        best_ask_e6: string | null;
        spread_e6: string | null;
      }
    | undefined,
): {
  bestBidE6: bigint | null;
  bestAskE6: bigint | null;
  spreadE6: bigint | null;
} {
  if (!snap) {
    return { bestBidE6: null, bestAskE6: null, spreadE6: null };
  }
  return {
    bestBidE6: snap.best_bid_e6 ? BigInt(snap.best_bid_e6) : null,
    bestAskE6: snap.best_ask_e6 ? BigInt(snap.best_ask_e6) : null,
    spreadE6: snap.spread_e6 ? BigInt(snap.spread_e6) : null,
  };
}

function snapToReport(
  snap:
    | {
        market_slug: string;
        asset_id: string;
        outcome: string;
        captured_at: Date;
        best_bid_e6: string | null;
        best_ask_e6: string | null;
      }
    | undefined,
): unknown {
  if (!snap) {
    return null;
  }
  return {
    marketSlug: snap.market_slug,
    assetId: snap.asset_id,
    outcome: snap.outcome,
    capturedAt: snap.captured_at.toISOString(),
    bestBid: snap.best_bid_e6 ? fromScaledInt(BigInt(snap.best_bid_e6), 1_000_000) : null,
    bestAsk: snap.best_ask_e6 ? fromScaledInt(BigInt(snap.best_ask_e6), 1_000_000) : null,
  };
}

function formatBidAsk(book: { bestBidE6: bigint | null; bestAskE6: bigint | null }): string {
  const bid = book.bestBidE6 ? fromScaledInt(book.bestBidE6, 1_000_000) : "n/a";
  const ask = book.bestAskE6 ? fromScaledInt(book.bestAskE6, 1_000_000) : "n/a";
  return `${bid} / ${ask}`;
}

function formatAgeMs(ageMs: number | null): string {
  if (ageMs === null) {
    return "n/a";
  }
  if (ageMs < 1000) {
    return `${ageMs}ms`;
  }
  return `${(ageMs / 1000).toFixed(1)}s`;
}

function decideStatus(args: {
  hasMarket: boolean;
  hasNext: boolean;
  snapAgeMs: number | null;
  priceAgeMs: number | null;
  upCrossed: boolean;
  downCrossed: boolean;
  complementOk: boolean;
}): "OK" | "WARN" | "FAIL" {
  if (!args.hasMarket) {
    return "FAIL";
  }
  if (args.snapAgeMs === null || args.snapAgeMs > FRESH_BOOK_SNAPSHOT_THRESHOLD_MS) {
    return "FAIL";
  }
  let warn = false;
  if (!args.hasNext) {
    warn = true;
  }
  if (args.priceAgeMs === null || args.priceAgeMs > FRESH_PRICE_SNAPSHOT_THRESHOLD_MS) {
    warn = true;
  }
  if (args.upCrossed || args.downCrossed) {
    warn = true;
  }
  if (!args.complementOk) {
    warn = true;
  }
  return warn ? "WARN" : "OK";
}
