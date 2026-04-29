import { env } from "@wiggler/constants/env";
import { defineCommand, defineValueOption } from "@wiggler/lib/cli";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { fromScaledInt } from "@wiggler/lib/domain/decimal";
import { PRICE_SOURCES, type PriceSource } from "@wiggler/lib/prices/types";
import { createShutdownController } from "@wiggler/lib/util/signal";
import { sleep } from "@wiggler/lib/util/sleep";
import { z } from "zod";

const POLL_INTERVAL_MS = 1000;
const PRICE_SCALE = 100_000_000;

/**
 * Tails new asset price snapshots — one row per scheduler tick per symbol.
 */
export const tailPricesCommand = defineCommand({
  name: "tail:prices",
  summary: "Tail new asset price snapshots",
  description:
    "Polls asset_price_snapshots once per second and streams new rows for the chosen symbol to stdout.",
  options: [
    defineValueOption({
      key: "asset",
      long: "--asset",
      valueName: "SYMBOL",
      schema: z.string().default(env.defaultAsset),
    }),
  ],
  examples: ["bun wiggler tail:prices --asset BTC"],
  output: "Streams JSON lines per new asset price snapshot.",
  sideEffects: "Polls PostgreSQL until cancelled.",
  async run({ io, options }) {
    const controller = createShutdownController();
    const db = createDatabase();
    const symbol = options.asset.toUpperCase();
    try {
      let lastId = await getMaxId(db, symbol);
      while (!controller.signal.aborted) {
        const rows = await db
          .selectFrom("asset_price_snapshots")
          .selectAll()
          .where("symbol", "=", symbol)
          .where("id", ">", lastId.toString())
          .orderBy("id", "asc")
          .limit(500)
          .execute();
        for (const row of rows) {
          const sources: Record<string, unknown> = {};
          for (const source of PRICE_SOURCES) {
            const mid = readMid(row, source);
            const ageMs = readAgeMs(row, source);
            sources[source] = {
              mid: mid !== null ? fromScaledInt(BigInt(mid), PRICE_SCALE) : null,
              ageMs,
            };
          }
          io.writeStdout(
            `${JSON.stringify({
              id: row.id,
              ts: row.captured_at.toISOString(),
              symbol: row.symbol,
              blended: row.blended_mid_e8
                ? fromScaledInt(BigInt(row.blended_mid_e8), PRICE_SCALE)
                : null,
              sources,
              sourceCount: row.source_count,
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

async function getMaxId(
  db: ReturnType<typeof createDatabase>,
  symbol: string,
): Promise<bigint> {
  const row = await db
    .selectFrom("asset_price_snapshots")
    .select((eb) => [eb.fn.max("id").as("max_id")])
    .where("symbol", "=", symbol)
    .executeTakeFirst();
  return row?.max_id ? BigInt(row.max_id) : 0n;
}

function readMid(row: Record<string, unknown>, source: PriceSource): string | null {
  const value = row[`${source}_mid_e8`];
  if (typeof value === "string") {return value;}
  if (typeof value === "number" || typeof value === "bigint") {return value.toString();}
  return null;
}

function readAgeMs(row: Record<string, unknown>, source: PriceSource): number | null {
  const value = row[`${source}_age_ms`];
  if (value === null || value === undefined) {return null;}
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
