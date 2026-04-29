import { defineCommand, defineValueOption } from "@wiggler/lib/cli";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { fromScaledInt } from "@wiggler/lib/domain/decimal";
import { createShutdownController } from "@wiggler/lib/util/signal";
import { sleep } from "@wiggler/lib/util/sleep";
import { z } from "zod";

const POLL_INTERVAL_MS = 1000;

/**
 * Tails new book snapshot rows.
 */
export const tailBooksCommand = defineCommand({
  name: "tail:books",
  summary: "Tail new book snapshots",
  description:
    "Polls book_snapshots once per second and streams new top-of-book snapshots to stdout.",
  options: [
    defineValueOption({
      key: "asset",
      long: "--asset",
      valueName: "SYMBOL",
      schema: z.string().default("BTC"),
    }),
  ],
  examples: ["bun wiggler tail:books --asset BTC"],
  output: "Streams JSON lines per new snapshot.",
  sideEffects: "Polls PostgreSQL until cancelled.",
  async run({ io }) {
    const controller = createShutdownController();
    const db = createDatabase();
    try {
      let lastId = await getMaxId(db);
      while (!controller.signal.aborted) {
        const rows = await db
          .selectFrom("book_snapshots")
          .select([
            "id",
            "captured_at",
            "market_slug",
            "outcome",
            "best_bid_e6",
            "best_ask_e6",
          ])
          .where("id", ">", lastId.toString())
          .orderBy("id", "asc")
          .limit(500)
          .execute();
        for (const row of rows) {
          io.writeStdout(
            `${JSON.stringify({
              id: row.id,
              ts: row.captured_at.toISOString(),
              slug: row.market_slug,
              outcome: row.outcome,
              bestBid: row.best_bid_e6
                ? fromScaledInt(BigInt(row.best_bid_e6), 1_000_000)
                : null,
              bestAsk: row.best_ask_e6
                ? fromScaledInt(BigInt(row.best_ask_e6), 1_000_000)
                : null,
            })}\n`,
          );
          lastId = BigInt(row.id);
        }
        try {
          await sleep(POLL_INTERVAL_MS, controller.signal);
        } catch {
          break;
        }
      }
    } finally {
      await destroyDatabase(db);
    }
  },
});

async function getMaxId(db: ReturnType<typeof createDatabase>): Promise<bigint> {
  const row = await db
    .selectFrom("book_snapshots")
    .select((eb) => [eb.fn.max("id").as("max_id")])
    .executeTakeFirst();
  return row?.max_id ? BigInt(row.max_id) : 0n;
}
