import { promises as fs } from "node:fs";
import path from "node:path";

import { defineCommand, defineValueOption } from "@wiggler/lib/cli";
import { CliUsageError } from "@wiggler/lib/cli/parser";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { fromScaledInt } from "@wiggler/lib/domain/decimal";
import { getMarketBySlug } from "@wiggler/lib/polymarket/queries/markets";
import { z } from "zod";

const PAGE_SIZE = 500;

/**
 * Streams normalized book snapshots (with top-N levels) for a market into NDJSON.
 */
export const exportSnapshotsCommand = defineCommand({
  name: "export:snapshots",
  summary: "Export book snapshots for a market to NDJSON",
  description:
    "Pulls book_snapshots and the joined book_levels rows for the given market and writes each snapshot as an NDJSON line.",
  options: [
    defineValueOption({
      key: "market",
      long: "--market",
      valueName: "SLUG",
      schema: z.string().min(1),
    }),
    defineValueOption({
      key: "out",
      long: "--out",
      valueName: "PATH",
      schema: z.string().min(1),
    }),
  ],
  examples: [
    "bun wiggler export:snapshots --market btc-updown-5m-1777475700 --out tmp/snapshots.ndjson",
  ],
  output: "Prints summary; snapshots go to the file.",
  sideEffects: "Writes the output file and reads PostgreSQL.",
  async run({ io, options }) {
    const db = createDatabase();
    try {
      const market = await getMarketBySlug(db, options.market);
      if (!market) {
        throw new CliUsageError(`unknown market: ${options.market}`);
      }

      await fs.mkdir(path.dirname(options.out), { recursive: true });
      const handle = await fs.open(options.out, "w");
      let total = 0;

      try {
        let lastId: bigint = 0n;
        for (;;) {
          const snapshots = await db
            .selectFrom("book_snapshots")
            .selectAll()
            .where("market_slug", "=", options.market)
            .where("id", ">", lastId.toString())
            .orderBy("id", "asc")
            .limit(PAGE_SIZE)
            .execute();
          if (snapshots.length === 0) {
            break;
          }
          const ids = snapshots.map((s) => s.id);
          const levels = await db
            .selectFrom("book_levels")
            .select(["snapshot_id", "side", "level_index", "price_e6", "size_e6"])
            .where("snapshot_id", "in", ids as never)
            .execute();
          const levelsByid = new Map<string, typeof levels>();
          for (const level of levels) {
            const key = String(level.snapshot_id);
            const list = levelsByid.get(key) ?? [];
            list.push(level);
            levelsByid.set(key, list);
          }
          const lines: string[] = [];
          for (const snap of snapshots) {
            const snapLevels = (levelsByid.get(String(snap.id)) ?? [])
              .slice()
              .sort((a, b) => a.level_index - b.level_index);
            lines.push(
              JSON.stringify({
                id: snap.id,
                marketSlug: snap.market_slug,
                conditionId: snap.condition_id,
                assetId: snap.asset_id,
                outcome: snap.outcome,
                capturedAt: snap.captured_at.toISOString(),
                capturedAtMs: Number(snap.captured_at_ms),
                bestBid: snap.best_bid_e6
                  ? fromScaledInt(BigInt(snap.best_bid_e6), 1_000_000)
                  : null,
                bestAsk: snap.best_ask_e6
                  ? fromScaledInt(BigInt(snap.best_ask_e6), 1_000_000)
                  : null,
                tickSize: snap.tick_size_e6
                  ? fromScaledInt(BigInt(snap.tick_size_e6), 1_000_000)
                  : null,
                bookHash: snap.book_hash,
                depthLimit: snap.depth_limit,
                bids: snapLevels
                  .filter((l) => l.side === "bid")
                  .map((l) => ({
                    levelIndex: l.level_index,
                    price: fromScaledInt(BigInt(l.price_e6), 1_000_000),
                    size: fromScaledInt(BigInt(l.size_e6), 1_000_000),
                  })),
                asks: snapLevels
                  .filter((l) => l.side === "ask")
                  .map((l) => ({
                    levelIndex: l.level_index,
                    price: fromScaledInt(BigInt(l.price_e6), 1_000_000),
                    size: fromScaledInt(BigInt(l.size_e6), 1_000_000),
                  })),
              }),
            );
          }
          await handle.write(`${lines.join("\n")}\n`);
          total += snapshots.length;
          lastId = BigInt(snapshots[snapshots.length - 1]!.id);
        }
      } finally {
        await handle.close();
      }

      io.writeStdout(
        `market: ${options.market}\nexported: ${total}\nfile: ${options.out}\n`,
      );
    } finally {
      await destroyDatabase(db);
    }
  },
});
