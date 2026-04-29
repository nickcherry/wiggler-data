import { getStartAnchor } from "@wiggler/lib/analysis/startAnchor";
import { getWindowTimeSeries } from "@wiggler/lib/analysis/windowTimeSeries";
import { defineCommand, defineFlagOption, definePositional } from "@wiggler/lib/cli";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { fromScaledInt } from "@wiggler/lib/domain/decimal";
import { getMarketBySlug } from "@wiggler/lib/polymarket/queries/markets";
import { z } from "zod";

const PRICE_E6 = 1_000_000;
const PRICE_E8 = 100_000_000;

/**
 * Per-second analysis of one resolved (or in-progress) market. Joins the
 * Polymarket book snapshot to the blended CEX price snapshot at the same
 * scheduler tick and reports the signed `pct_move` from the start anchor
 * alongside the Up/Down top-of-book at every second.
 *
 * Read-only. The output is intended as the eyeball test before running
 * `backtest:trigger` — confirm the trajectory looks the way you expect for
 * a known market before sweeping parameters.
 */
export const analyzeWindowCommand = defineCommand({
  name: "analyze:window",
  summary: "Per-second timeline for one market: pct_move + top-of-book",
  description:
    "Loads one market's snapshot history and emits a per-second time series of blended_mid, signed pct_move from the start anchor, and Up/Down top-of-book.",
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
  examples: ["bun wiggler analyze:window btc-updown-5m-1777494000"],
  output: "Prints a header block and a per-second time series (or JSON).",
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

      const anchor = await getStartAnchor(db, {
        assetSymbol: market.asset_symbol,
        startTs: market.start_ts,
      });

      const series = await getWindowTimeSeries(db, {
        marketSlug: market.slug,
        assetSymbol: market.asset_symbol,
        startTs: market.start_ts,
        endTs: market.end_ts,
        anchor,
      });

      if (options.json) {
        io.writeStdout(
          `${JSON.stringify(
            {
              slug: market.slug,
              asset: market.asset_symbol,
              startTs: market.start_ts.toISOString(),
              endTs: market.end_ts.toISOString(),
              resolved: market.resolved,
              resolvedOutcome: market.resolved_outcome,
              startAnchor: anchor
                ? {
                    blendedMid: fromScaledInt(anchor.blendedMidE8, PRICE_E8),
                    anchorAt: anchor.anchorAt.toISOString(),
                  }
                : null,
              series: series.map((row) => ({
                capturedAt: row.capturedAt.toISOString(),
                secondsSinceStart: row.secondsSinceStart,
                secondsLeft: row.secondsLeft,
                blendedMid:
                  row.blendedMidE8 !== null
                    ? fromScaledInt(row.blendedMidE8, PRICE_E8)
                    : null,
                pctMove: row.pctMove,
                upBid: row.upBidE6 !== null ? fromScaledInt(row.upBidE6, PRICE_E6) : null,
                upAsk: row.upAskE6 !== null ? fromScaledInt(row.upAskE6, PRICE_E6) : null,
                downBid:
                  row.downBidE6 !== null ? fromScaledInt(row.downBidE6, PRICE_E6) : null,
                downAsk:
                  row.downAskE6 !== null ? fromScaledInt(row.downAskE6, PRICE_E6) : null,
              })),
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      const lines: string[] = [];
      lines.push(`slug:        ${market.slug}`);
      lines.push(`asset:       ${market.asset_symbol}`);
      lines.push(
        `window:      ${market.start_ts.toISOString()} -> ${market.end_ts.toISOString()}`,
      );
      lines.push(
        `resolved:    ${market.resolved ? (market.resolved_outcome ?? "yes") : "no"}`,
      );
      if (anchor) {
        lines.push(
          `start_price: ${fromScaledInt(anchor.blendedMidE8, PRICE_E8)} (anchor at ${anchor.anchorAt.toISOString()})`,
        );
      } else {
        lines.push("start_price: (no CEX snapshot at or after start_ts)");
      }
      lines.push("");
      lines.push(
        "second  blended       pct%      up_bid up_ask  down_bid down_ask",
      );
      for (const row of series) {
        const blended =
          row.blendedMidE8 !== null
            ? fromScaledInt(row.blendedMidE8, PRICE_E8).padStart(11)
            : "n/a".padStart(11);
        const pct =
          row.pctMove !== null
            ? `${(row.pctMove * 100).toFixed(3)}%`.padStart(8)
            : "n/a".padStart(8);
        lines.push(
          `${row.secondsSinceStart.toString().padStart(6)}  ${blended}  ${pct}   ${formatPriceE6(row.upBidE6)} ${formatPriceE6(row.upAskE6)}    ${formatPriceE6(row.downBidE6)}   ${formatPriceE6(row.downAskE6)}`,
        );
      }
      io.writeStdout(`${lines.join("\n")}\n`);
    } finally {
      await destroyDatabase(db);
    }
  },
});

function formatPriceE6(value: bigint | null): string {
  return value !== null ? fromScaledInt(value, PRICE_E6).padStart(6) : "  n/a ";
}
