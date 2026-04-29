import { env } from "@wiggler/constants/env";
import { defineCommand, defineFlagOption, defineValueOption } from "@wiggler/lib/cli";
import { getFiveMinuteWindow } from "@wiggler/lib/domain/marketWindow";
import { formatParsedMarketBlock } from "@wiggler/lib/format/formatMarket";
import { fetchGammaEventBySlug } from "@wiggler/lib/polymarket/gammaClient";
import { parseGammaEvent } from "@wiggler/lib/polymarket/parseEvent";
import { buildUpDownSlugFromWindow } from "@wiggler/lib/polymarket/slug";
import { z } from "zod";

/**
 * Looks up the Up/Down 5-minute market that covers the current moment.
 */
export const marketCurrentCommand = defineCommand({
  name: "market:current",
  summary: "Look up the current Up/Down 5m market",
  description:
    "Computes the active 5-minute window from the wall clock and fetches the matching Polymarket Gamma event for the given asset.",
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
  examples: ["bun wiggler market:current --asset BTC"],
  output: "Prints the parsed current-market metadata.",
  sideEffects: "Reads from the Polymarket Gamma API; no database writes.",
  async run({ io, options }) {
    const assetSymbol = options.asset.toUpperCase();
    const window = getFiveMinuteWindow();
    const slug = buildUpDownSlugFromWindow(assetSymbol, window);
    const result = await fetchGammaEventBySlug(slug);

    if (result.status === "not_found") {
      io.writeStdout(
        `slug: ${slug}\nwindow: ${new Date(window.startMs).toISOString()} -> ${new Date(window.endMs).toISOString()}\nstatus: not_found\n`,
      );
      return;
    }
    if (result.status === "error") {
      throw new Error(`Gamma error ${result.httpStatus}: ${result.body}`);
    }

    const parsed = parseGammaEvent({
      event: result.event,
      raw: result.raw,
      assetSymbol,
    });

    if (!parsed) {
      io.writeStdout(
        `slug: ${slug}\nstatus: parse_error\nraw_keys: ${Object.keys(result.raw ?? {}).join(",")}\n`,
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
