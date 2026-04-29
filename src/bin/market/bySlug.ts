import { env } from "@wiggler/constants/env";
import { defineCommand, defineFlagOption, definePositional } from "@wiggler/lib/cli";
import { formatParsedMarketBlock } from "@wiggler/lib/format/formatMarket";
import { fetchGammaEventBySlug } from "@wiggler/lib/polymarket/gammaClient";
import { parseGammaEvent } from "@wiggler/lib/polymarket/parseEvent";
import { z } from "zod";

/**
 * Fetches a Polymarket event by exact slug. Useful for inspecting a specific
 * historical window.
 */
export const marketBySlugCommand = defineCommand({
  name: "market:by-slug",
  summary: "Look up a Polymarket event by slug",
  description:
    "Calls Gamma /events/slug/{slug} for the given slug and prints the parsed market metadata.",
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
  examples: ["bun wiggler market:by-slug btc-updown-5m-1777475700"],
  output: "Prints the parsed market metadata for the slug.",
  sideEffects: "Reads from Polymarket Gamma; no database writes.",
  async run({ io, positionals, options }) {
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
      io.writeStdout(
        `slug: ${positionals.slug}\nstatus: parse_error\nraw_keys: ${Object.keys((result.raw ?? {})).join(",")}\n`,
      );
      return;
    }
    if (options.json) {
      io.writeStdout(`${JSON.stringify(parsed, null, 2)}\n`);
      return;
    }
    io.writeStdout(`${formatParsedMarketBlock(parsed)}\n`);
  },
});
