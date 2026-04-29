import { env } from "@wiggler/constants/env";
import { runBacktest } from "@wiggler/lib/analysis/backtest";
import type { Side, TriggerConfig } from "@wiggler/lib/analysis/types";
import { defineCommand, defineFlagOption, defineValueOption } from "@wiggler/lib/cli";
import { CliUsageError } from "@wiggler/lib/cli/parser";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { priceToE6, sizeToE6 } from "@wiggler/lib/domain/decimal";
import { z } from "zod";

const sideSchema = z.enum(["Up", "Down", "up", "down"]).transform((s): Side =>
  s.toLowerCase() === "up" ? "Up" : "Down",
);

/**
 * Walks every resolved market for the given asset and reports how often a
 * single trigger configuration would have fired plus the realized hit rate
 * and mean PnL per share if those triggers had been traded at best-ask.
 *
 * The five flags below ARE the trade rule. Once you find a configuration
 * that performs the way you want, the live trader is just "evaluate this
 * predicate against the latest snapshots once per second."
 */
export const backtestTriggerCommand = defineCommand({
  name: "backtest:trigger",
  summary: "Backtest one trigger configuration across all resolved markets",
  description:
    "For each resolved market in the asset's pool, walks every snapshot tick of the chosen side's book and counts the moments where the predicate (min pct move, max seconds left, max entry ask, min fillable depth) holds. Reports trigger count, hit rate (resolution matched the bet side), and mean PnL per share (win pays 1-entry, loss pays -entry; fees not modeled).",
  options: [
    defineValueOption({
      key: "asset",
      long: "--asset",
      valueName: "SYMBOL",
      schema: z.string().default(env.defaultAsset),
    }),
    defineValueOption({
      key: "side",
      long: "--side",
      valueName: "Up|Down",
      schema: sideSchema,
    }),
    defineValueOption({
      key: "minPctMove",
      long: "--min-pct-move",
      valueName: "FRACTION",
      schema: z.coerce.number().positive().max(1),
    }),
    defineValueOption({
      key: "maxSecondsLeft",
      long: "--max-seconds-left",
      valueName: "SECONDS",
      schema: z.coerce.number().int().positive().max(300),
    }),
    defineValueOption({
      key: "maxEntryPrice",
      long: "--max-entry-price",
      valueName: "PROBABILITY",
      schema: z.coerce.number().positive().max(1),
    }),
    defineValueOption({
      key: "minFillSize",
      long: "--min-fill-size",
      valueName: "SHARES",
      schema: z.coerce.number().positive(),
    }),
    defineFlagOption({
      key: "json",
      long: "--json",
      schema: z.boolean().default(false),
    }),
  ],
  examples: [
    "bun wiggler backtest:trigger --side Up --min-pct-move 0.005 --max-seconds-left 60 --max-entry-price 0.85 --min-fill-size 100",
    "bun wiggler backtest:trigger --side Down --min-pct-move 0.007 --max-seconds-left 30 --max-entry-price 0.90 --min-fill-size 50 --json",
  ],
  output:
    "Prints one config-result block (or JSON) with resolved-market count, trigger count, hit count, hit rate, and mean PnL per share.",
  sideEffects: "Reads PostgreSQL only. No writes.",
  async run({ io, options }) {
    const config: TriggerConfig = {
      side: options.side,
      minPctMove: options.minPctMove,
      maxSecondsLeft: options.maxSecondsLeft,
      maxEntryPriceE6: priceToE6(options.maxEntryPrice),
      minFillableSizeE6: sizeToE6(options.minFillSize),
    };
    if (config.maxEntryPriceE6 <= 0n || config.minFillableSizeE6 <= 0n) {
      throw new CliUsageError("--max-entry-price and --min-fill-size must be > 0");
    }

    const db = createDatabase();
    try {
      const result = await runBacktest(db, {
        assetSymbol: options.asset.toUpperCase(),
        config,
      });

      if (options.json) {
        io.writeStdout(
          `${JSON.stringify(
            {
              asset: options.asset.toUpperCase(),
              config: {
                side: config.side,
                minPctMove: config.minPctMove,
                maxSecondsLeft: config.maxSecondsLeft,
                maxEntryPrice: options.maxEntryPrice,
                minFillSize: options.minFillSize,
              },
              resolvedMarkets: result.resolvedMarkets,
              triggers: result.triggers,
              hits: result.hits,
              misses: result.misses,
              hitRate: result.hitRate,
              meanPnlPerShare: result.meanPnlPerShare,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      const lines: string[] = [];
      lines.push(`asset:               ${options.asset.toUpperCase()}`);
      lines.push(`side:                ${config.side}`);
      lines.push(`min_pct_move:        ${(config.minPctMove * 100).toFixed(3)}%`);
      lines.push(`max_seconds_left:    ${config.maxSecondsLeft}`);
      lines.push(`max_entry_price:     ${options.maxEntryPrice}`);
      lines.push(`min_fill_size:       ${options.minFillSize}`);
      lines.push("");
      lines.push(`resolved_markets:    ${result.resolvedMarkets}`);
      lines.push(`triggers:            ${result.triggers}`);
      lines.push(`hits:                ${result.hits}`);
      lines.push(`misses:              ${result.misses}`);
      lines.push(
        `hit_rate:            ${result.hitRate !== null ? `${(result.hitRate * 100).toFixed(2)}%` : "n/a"}`,
      );
      lines.push(
        `mean_pnl_per_share:  ${result.meanPnlPerShare !== null ? result.meanPnlPerShare.toFixed(4) : "n/a"}`,
      );
      io.writeStdout(`${lines.join("\n")}\n`);
    } finally {
      await destroyDatabase(db);
    }
  },
});
