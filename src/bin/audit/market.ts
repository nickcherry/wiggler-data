import { defineCommand, defineFlagOption, definePositional } from "@wiggler/lib/cli";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { getMarketAuditCounts } from "@wiggler/lib/polymarket/queries/audit";
import { getMarketBySlug } from "@wiggler/lib/polymarket/queries/markets";
import { z } from "zod";

const EXPECTED_BASE_INTERVAL_MS = 1_000;

/**
 * Audits a single market: metadata + book snapshot coverage.
 */
export const auditMarketCommand = defineCommand({
  name: "audit:market",
  summary: "Audit a single market by slug",
  description:
    "Reports metadata + book snapshot coverage for the given market slug.",
  positionals: [
    definePositional({
      key: "slug",
      valueName: "SLUG",
      schema: z.string().min(1),
    }),
  ],
  options: [
    defineFlagOption({
      key: "json",
      long: "--json",
      schema: z.boolean().default(false),
    }),
  ],
  examples: ["bun wiggler audit:market btc-updown-5m-1777475700"],
  output: "Prints market audit text or JSON.",
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
      const counts = await getMarketAuditCounts(db, { marketSlug: market.slug });
      const windowMs = market.end_ts.getTime() - market.start_ts.getTime();
      // 1 snapshot per cadence tick × 2 outcomes (Up + Down) for the entire window.
      const expectedSnapshots = Math.max(
        0,
        Math.floor(windowMs / EXPECTED_BASE_INTERVAL_MS) * 2,
      );

      if (options.json) {
        io.writeStdout(
          `${JSON.stringify(
            {
              slug: market.slug,
              startTs: market.start_ts.toISOString(),
              endTs: market.end_ts.toISOString(),
              conditionId: market.condition_id,
              upTokenId: market.up_token_id,
              downTokenId: market.down_token_id,
              counts,
              expectedSnapshots,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      const lines = [
        `slug: ${market.slug}`,
        `asset: ${market.asset_symbol}`,
        `window: ${market.start_ts.toISOString()} -> ${market.end_ts.toISOString()}`,
        `condition_id: ${market.condition_id ?? "(none)"}`,
        `up_token_id: ${market.up_token_id ?? "(none)"}`,
        `down_token_id: ${market.down_token_id ?? "(none)"}`,
        `resolved: ${market.resolved ? "yes" : "no"}`,
        `resolved_outcome: ${market.resolved_outcome ?? "(none)"}`,
        `book_snapshots: ${counts.snapshots} (expected ~${expectedSnapshots})`,
        `first_snapshot_at: ${counts.firstSnapshotAt?.toISOString() ?? "(none)"}`,
        `last_snapshot_at: ${counts.lastSnapshotAt?.toISOString() ?? "(none)"}`,
      ];
      io.writeStdout(`${lines.join("\n")}\n`);
    } finally {
      await destroyDatabase(db);
    }
  },
});
