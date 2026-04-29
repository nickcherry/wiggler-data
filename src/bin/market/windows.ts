import { env } from "@wiggler/constants/env";
import { defineCommand, defineValueOption } from "@wiggler/lib/cli";
import { CliUsageError } from "@wiggler/lib/cli/parser";
import { getFiveMinuteWindowSeries } from "@wiggler/lib/domain/marketWindow";
import { buildUpDownSlugFromWindow } from "@wiggler/lib/polymarket/slug";
import { z } from "zod";

/**
 * Prints the 5-minute window series and the canonical Up/Down slug for each
 * around the supplied reference moment.
 */
export const marketWindowsCommand = defineCommand({
  name: "market:windows",
  summary: "List 5-minute market windows around a reference time",
  description:
    "Shows the slugs and ISO bounds for the 5-minute windows surrounding the given moment.",
  options: [
    defineValueOption({
      key: "asset",
      long: "--asset",
      valueName: "SYMBOL",
      schema: z.string().default(env.defaultAsset),
    }),
    defineValueOption({
      key: "around",
      long: "--around",
      valueName: "ISO_OR_NOW",
      schema: z.string().default("now"),
    }),
    defineValueOption({
      key: "lookback",
      long: "--lookback",
      valueName: "COUNT",
      schema: z.coerce.number().int().min(0).max(60).default(2),
    }),
    defineValueOption({
      key: "lookahead",
      long: "--lookahead",
      valueName: "COUNT",
      schema: z.coerce.number().int().min(0).max(60).default(2),
    }),
  ],
  examples: ["bun wiggler market:windows --asset BTC --around now"],
  output: "Prints a table of 5-minute windows and their canonical slugs.",
  sideEffects: "None.",
  async run({ io, options }) {
    const assetSymbol = options.asset.toUpperCase();
    const reference = parseReference(options.around);
    const windows = getFiveMinuteWindowSeries({
      reference,
      lookback: options.lookback,
      lookahead: options.lookahead,
    });
    const lines: string[] = ["start_iso                 end_iso                   slug"];
    for (const window of windows) {
      const slug = buildUpDownSlugFromWindow(assetSymbol, window);
      lines.push(
        `${new Date(window.startMs).toISOString()}  ${new Date(window.endMs).toISOString()}  ${slug}`,
      );
    }
    io.writeStdout(`${lines.join("\n")}\n`);
  },
});

function parseReference(input: string): Date {
  if (input === "now") {
    return new Date();
  }
  const ms = Date.parse(input);
  if (!Number.isFinite(ms)) {
    throw new CliUsageError(`Invalid --around value: ${input}`);
  }
  return new Date(ms);
}
