import type { Timeframe } from "@wiggler/constants/candles";
import { bpsChange } from "@wiggler/lib/candles/lookahead";
import {
  buildSeriesArrays,
  type ClosePoint,
} from "@wiggler/lib/candles/winProbGrid";
import type { DatabaseClient } from "@wiggler/lib/db/types";
import { sql } from "kysely";

/**
 * Training diagnostics report. Surfaces the things that are typically
 * responsible for a calibrated probability grid looking sane in
 * aggregate but producing wildly imbalanced or "stuck" buckets.
 *
 * Specifically targets the HYPE / BNB anchor-imbalance problem
 * ChatGPT flagged in the v1 analysis — by reporting:
 *
 *   - tie counts (how many decision states had `current_price ==
 *     line_price` exactly, or `final_price == line_price`)
 *   - up/down anchor balance per month (asymmetry that grows with
 *     time often points to source-composition drift)
 *   - per-source and per-month source counts contributing to the
 *     vwap aggregate (composition shifts when a venue starts feeding
 *     create phantom directional moves in the proxy)
 */

export type TieDiagnostics = Readonly<{
  /** Total decision states scanned. */
  decisionRows: number;
  /** Decision states where `current_price == line_price` exactly. */
  currentEqualsLine: number;
  /** Anchors where `final_price == line_price` exactly (tie-to-Up wins). */
  finalEqualsLine: number;
  /** Decision states where `abs_d_bps < N` (multiple thresholds). */
  absDBpsBelowEpsilon: ReadonlyArray<{ epsilon: number; count: number }>;
}>;

export type AnchorMonthRow = Readonly<{
  monthIso: string;
  upWins: number;
  downWins: number;
  upShare: number;
}>;

export type SourceMonthRow = Readonly<{
  monthIso: string;
  /** Distinct source count contributing to vwap that month. */
  uniqueSources: number;
  /** Per-source row counts that month. */
  perSource: ReadonlyArray<{ source: string; rows: number }>;
}>;

export type TrainingDiagnostics = Readonly<{
  asset: string;
  timeframe: Timeframe;
  intervalSec: number;
  windowStartIso: string | null;
  windowEndIso: string | null;
  upAnchors: number;
  downAnchors: number;
  upShareAll: number;
  ties: TieDiagnostics;
  anchorBalanceByMonth: readonly AnchorMonthRow[];
  sourceCompositionByMonth: readonly SourceMonthRow[];
}>;

const TIE_EPSILONS_BPS: readonly number[] = [0.1, 0.5, 1, 2] as const;

/**
 * Walks decision states identically to `buildWinProbGrid` and counts
 * tie / near-tie occurrences plus per-month Up/Down anchor balance.
 * Anchor stride matches the requested mode.
 */
export function buildTieAndAnchorDiagnostics(args: {
  closes: readonly ClosePoint[];
  intervalSec: number;
  anchorStepMin: number;
  volLookbackMin: number;
}): Readonly<{
  ties: TieDiagnostics;
  upAnchors: number;
  downAnchors: number;
  anchorBalanceByMonth: readonly AnchorMonthRow[];
}> {
  const intervalMin = args.intervalSec / 60;
  const series = buildSeriesArrays({
    closes: args.closes,
    volLookbackMin: args.volLookbackMin,
  });

  let decisionRows = 0;
  let currentEqualsLine = 0;
  let finalEqualsLine = 0;
  const absDBpsBelowCounts = new Map<number, number>();
  for (const e of TIE_EPSILONS_BPS) {absDBpsBelowCounts.set(e, 0);}

  let upAnchors = 0;
  let downAnchors = 0;
  type MonthSlot = { upWins: number; downWins: number };
  const monthAnchors = new Map<string, MonthSlot>();
  const monthKey = (ms: number): string => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  };

  for (let i = 0; i + intervalMin < series.totalMinutes; i += args.anchorStepMin) {
    const line = series.closeAt[i];
    const finalPx = series.closeAt[i + intervalMin];
    if (line == null || finalPx == null || line <= 0n) {continue;}
    if (finalPx === line) {finalEqualsLine++;}
    if (finalPx >= line) {
      upAnchors++;
    } else {
      downAnchors++;
    }
    const anchorMs = series.baseMs + i * 60_000;
    const month = monthKey(anchorMs);
    let slot = monthAnchors.get(month);
    if (slot === undefined) {
      slot = { upWins: 0, downWins: 0 };
      monthAnchors.set(month, slot);
    }
    if (finalPx >= line) {
      slot.upWins++;
    } else {
      slot.downWins++;
    }
    for (let elapsedMin = 1; elapsedMin < intervalMin; elapsedMin++) {
      const decisionIdx = i + elapsedMin;
      const current = series.closeAt[decisionIdx];
      if (current == null || current <= 0n) {continue;}
      const vol = series.recentVolAt[decisionIdx];
      if (vol == null) {continue;}
      decisionRows++;
      if (current === line) {currentEqualsLine++;}
      const dBps = bpsChange(current, line);
      const absDBps = Math.abs(dBps);
      for (const e of TIE_EPSILONS_BPS) {
        if (absDBps < e) {
          absDBpsBelowCounts.set(e, absDBpsBelowCounts.get(e)! + 1);
        }
      }
    }
  }

  const anchorBalanceByMonth: AnchorMonthRow[] = [...monthAnchors.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([monthIso, slot]) => {
      const total = slot.upWins + slot.downWins;
      return {
        monthIso,
        upWins: slot.upWins,
        downWins: slot.downWins,
        upShare: total === 0 ? 0 : slot.upWins / total,
      };
    });

  const ties: TieDiagnostics = {
    decisionRows,
    currentEqualsLine,
    finalEqualsLine,
    absDBpsBelowEpsilon: TIE_EPSILONS_BPS.map((e) => ({
      epsilon: e,
      count: absDBpsBelowCounts.get(e)!,
    })),
  };
  return { ties, upAnchors, downAnchors, anchorBalanceByMonth };
}

/**
 * Counts distinct sources contributing to the vwap aggregate per
 * month. When a venue starts feeding mid-window (e.g. Coinbase HYPE
 * doesn't begin until Feb 2026), the vwap composition shifts and the
 * "current price" can drift mechanically rather than reflecting real
 * trades — phantom directional moves that propagate into the win-prob
 * grid as anchor imbalance.
 */
export async function loadSourceCompositionByMonth(
  db: DatabaseClient,
  args: Readonly<{ symbol: string; timeframe: Timeframe }>,
): Promise<readonly SourceMonthRow[]> {
  const result = await sql<{
    month_iso: string;
    source: string;
    rows: string;
  }>`
    SELECT
      to_char(date_trunc('month', open_time), 'YYYY-MM')         AS month_iso,
      source                                                      AS source,
      COUNT(*)::bigint                                            AS rows
    FROM candles
    WHERE symbol = ${args.symbol}
      AND timeframe = ${args.timeframe}
    GROUP BY 1, 2
    ORDER BY 1, 2
  `.execute(db);

  const byMonth = new Map<
    string,
    { uniqueSources: Set<string>; perSource: Array<{ source: string; rows: number }> }
  >();
  for (const row of result.rows) {
    let slot = byMonth.get(row.month_iso);
    if (slot === undefined) {
      slot = { uniqueSources: new Set<string>(), perSource: [] };
      byMonth.set(row.month_iso, slot);
    }
    slot.uniqueSources.add(row.source);
    slot.perSource.push({ source: row.source, rows: Number(row.rows) });
  }
  return [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([monthIso, slot]) => ({
      monthIso,
      uniqueSources: slot.uniqueSources.size,
      perSource: slot.perSource,
    }));
}
