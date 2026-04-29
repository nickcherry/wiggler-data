import { env } from "@wiggler/constants/env";
import { defineCommand, defineValueOption } from "@wiggler/lib/cli";
import { runCoordinator } from "@wiggler/lib/collector/coordinator";
import { createShutdownController } from "@wiggler/lib/util/signal";
import { z } from "zod";

/**
 * Starts the full wiggler collector: Polymarket market discovery + WS +
 * snapshot scheduler, plus Coinbase + Binance price-tick collection.
 * Handles SIGINT/SIGTERM cleanly.
 */
export const collectStartCommand = defineCommand({
  name: "collect:start",
  summary: "Start the wiggler data collector",
  description:
    "Connects to Polymarket Gamma + WebSocket, discovers Up/Down 5m markets, persists raw events / trades / book snapshots, and concurrently records Coinbase + Binance price ticks for the configured symbols until stopped.",
  options: [
    defineValueOption({
      key: "asset",
      long: "--asset",
      valueName: "SYMBOL",
      schema: z.string().default(env.defaultAsset),
    }),
    defineValueOption({
      key: "priceSymbols",
      long: "--price-symbols",
      valueName: "CSV",
      schema: z.string().optional(),
    }),
  ],
  examples: [
    "bun wiggler collect:start --asset BTC",
    "bun wiggler collect:start --asset BTC --price-symbols BTC,ETH",
  ],
  output: "Streams structured JSON log lines to stdout/stderr.",
  sideEffects:
    "Subscribes to Polymarket + Coinbase + Binance WebSockets and writes to PostgreSQL until stopped.",
  async run({ options }) {
    const controller = createShutdownController();
    const priceSymbols = options.priceSymbols
      ? options.priceSymbols
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter((s) => s.length > 0)
      : undefined;
    await runCoordinator({
      assetSymbol: options.asset.toUpperCase(),
      priceSymbols,
      signal: controller.signal,
    });
  },
});
