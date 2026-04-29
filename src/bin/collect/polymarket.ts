import { env } from "@wiggler/constants/env";
import { defineCommand, defineValueOption } from "@wiggler/lib/cli";
import { runCoordinator } from "@wiggler/lib/collector/coordinator";
import { createShutdownController } from "@wiggler/lib/util/signal";
import { z } from "zod";

/**
 * Runs only the Polymarket pieces of the coordinator (market discovery, WS,
 * book snapshots). CEX price collection is skipped — useful when the price
 * feeds are being inspected by another process.
 */
export const collectPolymarketCommand = defineCommand({
  name: "collect:polymarket",
  summary: "Collect Polymarket WS data only (no CEX price feeds)",
  description:
    "Runs the wiggler coordinator with only the Polymarket pieces (market discovery, WS, book snapshots).",
  options: [
    defineValueOption({
      key: "asset",
      long: "--asset",
      valueName: "SYMBOL",
      schema: z.string().default(env.defaultAsset),
    }),
  ],
  examples: ["bun wiggler collect:polymarket --asset BTC"],
  output: "Streams structured JSON log lines to stdout/stderr.",
  sideEffects: "Same as collect:start, scoped to Polymarket-only writes.",
  async run({ options }) {
    const controller = createShutdownController();
    await runCoordinator({
      assetSymbol: options.asset.toUpperCase(),
      disablePriceCollection: true,
      signal: controller.signal,
    });
  },
});
