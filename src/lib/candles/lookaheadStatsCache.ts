import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Timeframe } from "@wiggler/constants/candles";
import type { LookaheadSource } from "@wiggler/lib/candles/lookahead";
import {
  filterStatsRowsBySources,
  fingerprintsMatch,
  type LookaheadDistribution,
  type LookaheadFingerprint,
  type LookaheadMetric,
  type LookaheadStatsRow,
  summarizeOneMetric,
} from "@wiggler/lib/candles/lookaheadStats";
import type { DatabaseClient } from "@wiggler/lib/db/types";

/**
 * On-disk JSON cache for distribution-summary results, **per metric**.
 *
 * Layout: one file per `(symbol, timeframe, metric)`:
 *
 *   tmp/distributions/{SYMBOL}_{TF}/{metric}.json
 *
 * Why per-metric (and not per-request as we did before): so that
 * tweaking or adding a single metric only invalidates that metric's
 * cache, and changing `--sources` filters reuses the same cache file
 * (the file stores rows for ALL sources; the source filter is applied
 * client-side after read). This makes the iteration loop "rerun
 * distributions, look at one metric, tweak, rerun" actually leverage
 * the cache for the metrics that didn't change.
 *
 * Cache validity: a `LookaheadFingerprint` (count + latest open_time)
 * is recorded at write time and compared against the live DB on read.
 * If anything changed in `candle_lookahead_features` for that
 * (symbol, timeframe), every per-metric cache for that pair is
 * invalidated and the SQL is rerun — but only for metrics actually
 * requested in the current invocation.
 */

const DEFAULT_CACHE_DIR = "tmp/distributions";

/**
 * Cache file shape — single-metric, all-sources. `version` is bumped
 * if the format changes; on read, an unrecognized version is treated
 * as a cache miss.
 */
export type MetricCacheFile = Readonly<{
  version: 2;
  fingerprint: LookaheadFingerprint;
  computedAtIso: string;
  symbol: string;
  timeframe: string;
  metric: LookaheadMetric;
  rows: readonly LookaheadStatsRow[];
}>;

/**
 * Status of one per-metric cache lookup. The CLI surfaces this in the
 * human-readable report so it's obvious which metrics came from disk
 * and which were just computed.
 */
export type MetricCacheStatus = Readonly<
  | { status: "hit"; computedAtIso: string }
  | { status: "miss"; computedAtIso: string }
  | { status: "skipped" }
>;

/**
 * Returns the deterministic cache file path for one
 * `(symbol, timeframe, metric)`. Files are nested under a
 * symbol+timeframe directory so a quick `ls tmp/distributions/BTC_1m/`
 * shows every cached metric for that series.
 */
export function metricCachePath(args: {
  symbol: string;
  timeframe: Timeframe;
  metric: LookaheadMetric;
  cacheDir?: string;
}): string {
  return join(
    args.cacheDir ?? DEFAULT_CACHE_DIR,
    `${args.symbol}_${args.timeframe}`,
    `${args.metric}.json`,
  );
}

/**
 * Reads a per-metric cache file. Returns `null` on cache miss
 * (missing file, malformed JSON, wrong version, or fingerprint
 * mismatch — i.e. the cache is stale because the underlying data
 * moved). Never throws on a miss — that's a normal, expected outcome.
 */
export async function readMetricCache(
  path: string,
  expectedFingerprint: LookaheadFingerprint,
): Promise<MetricCacheFile | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isMetricCacheFile(parsed)) {
    return null;
  }
  if (!fingerprintsMatch(parsed.fingerprint, expectedFingerprint)) {
    return null;
  }
  return parsed;
}

/**
 * Writes a per-metric cache file, creating the parent directory if
 * needed. Overwrites any existing file at that path.
 */
export async function writeMetricCache(
  path: string,
  data: MetricCacheFile,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
}

/**
 * High-level orchestrator used by the CLI: loads each requested
 * metric's distribution rows, hitting the per-metric cache when
 * possible and computing + writing the cache otherwise. Applies the
 * source filter client-side (after the cache layer) so source
 * subsets reuse the same cache file.
 *
 * The returned `cacheStatus` map records whether each metric was a
 * hit / miss / skipped so the CLI can surface that under each section
 * heading.
 */
export async function loadDistributionsWithCache(
  db: DatabaseClient,
  args: Readonly<{
    symbol: string;
    timeframe: Timeframe;
    metrics: readonly LookaheadMetric[];
    sources: readonly LookaheadSource[];
    fingerprint: LookaheadFingerprint;
    useCache: boolean;
    cacheDir?: string;
  }>,
): Promise<{
  distributions: readonly LookaheadDistribution[];
  cacheStatus: ReadonlyMap<LookaheadMetric, MetricCacheStatus>;
}> {
  const distributions: LookaheadDistribution[] = [];
  const cacheStatus = new Map<LookaheadMetric, MetricCacheStatus>();

  for (const metric of args.metrics) {
    const path = metricCachePath({
      symbol: args.symbol,
      timeframe: args.timeframe,
      metric,
      cacheDir: args.cacheDir,
    });

    if (!args.useCache) {
      const allRows = await summarizeOneMetric(db, {
        symbol: args.symbol,
        timeframe: args.timeframe,
        metric,
      });
      distributions.push({
        metric,
        rows: filterStatsRowsBySources(allRows, args.sources),
      });
      cacheStatus.set(metric, { status: "skipped" });
      continue;
    }

    const cached = await readMetricCache(path, args.fingerprint);
    if (cached !== null) {
      distributions.push({
        metric,
        rows: filterStatsRowsBySources(cached.rows, args.sources),
      });
      cacheStatus.set(metric, {
        status: "hit",
        computedAtIso: cached.computedAtIso,
      });
      continue;
    }

    const allRows = await summarizeOneMetric(db, {
      symbol: args.symbol,
      timeframe: args.timeframe,
      metric,
    });
    const computedAtIso = new Date().toISOString();
    await writeMetricCache(path, {
      version: 2,
      fingerprint: args.fingerprint,
      computedAtIso,
      symbol: args.symbol,
      timeframe: args.timeframe,
      metric,
      rows: allRows,
    });
    distributions.push({
      metric,
      rows: filterStatsRowsBySources(allRows, args.sources),
    });
    cacheStatus.set(metric, { status: "miss", computedAtIso });
  }

  return { distributions, cacheStatus };
}

function isMetricCacheFile(value: unknown): value is MetricCacheFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (obj.version !== 2) {
    return false;
  }
  if (typeof obj.computedAtIso !== "string") {
    return false;
  }
  if (typeof obj.symbol !== "string") {
    return false;
  }
  if (typeof obj.timeframe !== "string") {
    return false;
  }
  if (typeof obj.metric !== "string") {
    return false;
  }
  if (!isFingerprint(obj.fingerprint)) {
    return false;
  }
  if (!Array.isArray(obj.rows)) {
    return false;
  }
  return true;
}

function isFingerprint(value: unknown): value is LookaheadFingerprint {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.rowCount !== "number") {
    return false;
  }
  if (obj.latestOpenTimeMs !== null && typeof obj.latestOpenTimeMs !== "number") {
    return false;
  }
  return true;
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if (!("code" in error)) {
    return false;
  }
  return (error).code === "ENOENT";
}
