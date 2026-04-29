import { defineCommand, defineFlagOption, definePositional, defineValueOption } from "@wiggler/lib/cli";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { fromScaledInt } from "@wiggler/lib/domain/decimal";
import { getMarketBySlug } from "@wiggler/lib/polymarket/queries/markets";
import { z } from "zod";

/**
 * Inspects book snapshots for a given market: either a compact time series or
 * a single point-in-time top-N view when --at is supplied.
 */
export const auditBookCommand = defineCommand({
  name: "audit:book",
  summary: "Inspect book snapshots for a single market",
  description:
    "Without --at, prints a compact time series of best bid/ask. With --at, prints the top-N levels at that moment.",
  positionals: [
    definePositional({
      key: "slug",
      valueName: "SLUG",
      schema: z.string().min(1),
    }),
  ],
  options: [
    defineValueOption({
      key: "at",
      long: "--at",
      valueName: "ISO",
      schema: z.string().optional(),
    }),
    defineValueOption({
      key: "depth",
      long: "--depth",
      valueName: "COUNT",
      schema: z.coerce.number().int().min(1).max(100).default(10),
    }),
    defineValueOption({
      key: "limit",
      long: "--limit",
      valueName: "COUNT",
      schema: z.coerce.number().int().min(1).max(2000).default(100),
    }),
    defineFlagOption({
      key: "json",
      long: "--json",
      schema: z.boolean().default(false),
    }),
  ],
  examples: [
    "bun wiggler audit:book btc-updown-5m-1777475700",
    "bun wiggler audit:book btc-updown-5m-1777475700 --at 2026-04-29T15:17:30Z --depth 10",
  ],
  output: "Prints either a time series or top-N levels.",
  sideEffects: "Reads PostgreSQL only.",
  async run({ io, positionals, options }) {
    const db = createDatabase();
    try {
      const market = await getMarketBySlug(db, positionals.slug);
      if (!market) {
        io.writeStdout(`slug: ${positionals.slug}\nstatus: not_found\n`);
        process.exitCode = 1;
        return;
      }

      if (!options.at) {
        await emitTimeSeries({ db, slug: market.slug, limit: options.limit, json: options.json, io });
        return;
      }

      await emitPointInTime({
        db,
        slug: market.slug,
        atMs: parseAt(options.at),
        depth: options.depth,
        json: options.json,
        io,
      });
    } finally {
      await destroyDatabase(db);
    }
  },
});

function parseAt(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid --at: ${value}`);
  }
  return ms;
}

async function emitTimeSeries(args: {
  db: ReturnType<typeof createDatabase>;
  slug: string;
  limit: number;
  json: boolean;
  io: { writeStdout: (text: string) => void };
}): Promise<void> {
  const rows = await args.db
    .selectFrom("book_snapshots")
    .select([
      "captured_at",
      "outcome",
      "best_bid_e6",
      "best_ask_e6",
      "spread_e6",
    ])
    .where("market_slug", "=", args.slug)
    .orderBy("captured_at", "asc")
    .limit(args.limit)
    .execute();

  if (args.json) {
    args.io.writeStdout(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  const lines = ["timestamp                  outcome bid    ask    spread"];
  for (const row of rows) {
    const bid = row.best_bid_e6 ? fromScaledInt(BigInt(row.best_bid_e6), 1_000_000) : "-";
    const ask = row.best_ask_e6 ? fromScaledInt(BigInt(row.best_ask_e6), 1_000_000) : "-";
    const spread = row.spread_e6 ? fromScaledInt(BigInt(row.spread_e6), 1_000_000) : "-";
    lines.push(
      `${row.captured_at.toISOString()}  ${row.outcome.padEnd(4)}    ${bid.padEnd(6)} ${ask.padEnd(6)} ${spread}`,
    );
  }
  args.io.writeStdout(`${lines.join("\n")}\n`);
}

async function emitPointInTime(args: {
  db: ReturnType<typeof createDatabase>;
  slug: string;
  atMs: number;
  depth: number;
  json: boolean;
  io: { writeStdout: (text: string) => void };
}): Promise<void> {
  const snapshots = await args.db
    .selectFrom("book_snapshots")
    .select(["id", "asset_id", "outcome", "captured_at"])
    .where("market_slug", "=", args.slug)
    .where("captured_at", "<=", new Date(args.atMs))
    .orderBy("captured_at", "desc")
    .limit(2)
    .execute();

  if (snapshots.length === 0) {
    args.io.writeStdout(`slug: ${args.slug}\nstatus: no_snapshots\n`);
    return;
  }

  const idToSnap = new Map(snapshots.map((s) => [s.id, s]));
  const ids = [...idToSnap.keys()];
  const levels = await args.db
    .selectFrom("book_levels")
    .select(["snapshot_id", "side", "level_index", "price_e6", "size_e6"])
    .where("snapshot_id", "in", ids as never)
    .orderBy("level_index", "asc")
    .execute();

  const grouped = new Map<string, typeof levels>();
  for (const level of levels) {
    const id = String(level.snapshot_id);
    const list = grouped.get(id) ?? [];
    list.push(level);
    grouped.set(id, list);
  }

  if (args.json) {
    args.io.writeStdout(
      `${JSON.stringify(
        {
          slug: args.slug,
          atTs: new Date(args.atMs).toISOString(),
          snapshots: snapshots.map((snap) => ({
            id: snap.id,
            outcome: snap.outcome,
            assetId: snap.asset_id,
            capturedAt: snap.captured_at.toISOString(),
            levels: grouped.get(String(snap.id)) ?? [],
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const lines: string[] = [];
  for (const snap of snapshots) {
    lines.push(
      `${snap.outcome} (${snap.captured_at.toISOString()}) asset_id=${snap.asset_id}`,
    );
    const snapLevels = (grouped.get(String(snap.id)) ?? []).slice(0, args.depth * 2);
    const bids = snapLevels.filter((l) => l.side === "bid");
    const asks = snapLevels.filter((l) => l.side === "ask");
    lines.push("  bids:");
    for (const level of bids) {
      lines.push(
        `    [${level.level_index}] ${fromScaledInt(BigInt(level.price_e6), 1_000_000)} x ${fromScaledInt(BigInt(level.size_e6), 1_000_000)}`,
      );
    }
    lines.push("  asks:");
    for (const level of asks) {
      lines.push(
        `    [${level.level_index}] ${fromScaledInt(BigInt(level.price_e6), 1_000_000)} x ${fromScaledInt(BigInt(level.size_e6), 1_000_000)}`,
      );
    }
  }
  args.io.writeStdout(`${lines.join("\n")}\n`);
}
