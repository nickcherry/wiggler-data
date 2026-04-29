import { env } from "@wiggler/constants/env";
import { defineCommand, definePositional } from "@wiggler/lib/cli";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { fetchGammaEventBySlug } from "@wiggler/lib/polymarket/gammaClient";
import { parseGammaEvent } from "@wiggler/lib/polymarket/parseEvent";
import { upsertMarket } from "@wiggler/lib/polymarket/upsertMarket";
import { z } from "zod";

/**
 * Re-fetches a market by slug and persists its current Gamma state. Useful
 * after a window has expired and Polymarket has resolved the outcome.
 */
export const marketResolveCommand = defineCommand({
  name: "market:resolve",
  summary: "Re-fetch and persist a market's resolution state",
  description:
    "Pulls the latest Gamma payload for a slug and upserts the resolved/closed flags into the database.",
  positionals: [
    definePositional({
      key: "slug",
      valueName: "SLUG",
      schema: z.string().min(1),
    }),
  ],
  examples: ["bun wiggler market:resolve btc-updown-5m-1777475700"],
  output: "Prints the new resolution state.",
  sideEffects: "Reads Gamma and writes to PostgreSQL.",
  async run({ io, positionals }) {
    const result = await fetchGammaEventBySlug(positionals.slug);
    if (result.status === "not_found") {
      io.writeStdout(`slug: ${positionals.slug}\nstatus: not_found\n`);
      return;
    }
    if (result.status === "error") {
      throw new Error(`Gamma error ${result.httpStatus}: ${result.body}`);
    }
    const parsed = parseGammaEvent({
      event: result.event,
      raw: result.raw,
      assetSymbol: env.defaultAsset,
    });
    if (!parsed) {
      throw new Error(`Could not parse market for slug ${positionals.slug}`);
    }
    const db = createDatabase();
    try {
      await upsertMarket(db, parsed);
    } finally {
      await destroyDatabase(db);
    }
    io.writeStdout(
      [
        `slug: ${parsed.slug}`,
        `resolved: ${parsed.resolved ? "yes" : "no"}`,
        `resolved_outcome: ${parsed.resolvedOutcome ?? "(none)"}`,
        `closed: ${parsed.closed ? "yes" : parsed.closed === false ? "no" : "(unknown)"}`,
        `status: ok`,
      ].join("\n") + "\n",
    );
  },
});
