import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Timeframe } from "@wiggler/constants/candles";
import type { LookaheadSource } from "@wiggler/lib/candles/lookahead";
import type {
  LookaheadDistribution,
  LookaheadFingerprint,
  LookaheadMetric,
} from "@wiggler/lib/candles/lookaheadStats";

/**
 * On-disk JSON cache for distribution-summary results.
 *
 * Why bother: the SQL is fast (sub-second), but iterating on
 * presentation, copying tables into docs, or re-rendering with
 * different `--sources` filters happens dozens of times per session.
 * Caching lets the CLI skip the round-trip to Postgres entirely when
 * nothing changed, which makes the "what does this look like for ETH
 * 5m?" loop instant rather than near-instant.
 *
 * Cache key: SHA-256 over the deterministic request shape (symbol,
 * timeframe, sorted sources, sorted metrics).
 *
 * Cache validity: a `LookaheadFingerprint` (count + latest open_time)
 * is recorded at write time and compared against the live DB on read.
 * If anything changed in `candle_lookahead_features` for that
 * (symbol, timeframe), the cache is invalidated and the SQL is rerun.
 *
 * Files live under `tmp/distributions/` (gitignored). Filenames
 * include the symbol + timeframe up front so a `ls tmp/distributions`
 * is human-scannable.
 */

/** Default cache directory, relative to the repo root. */
const DEFAULT_CACHE_DIR = "tmp/distributions";

/**
 * Cache file shape. `version` is bumped if we ever change the format
 * in a non-backwards-compatible way; on read, an unrecognized version
 * is treated as a cache miss.
 */
export type DistributionsCacheFile = Readonly<{
  version: 1;
  fingerprint: LookaheadFingerprint;
  computedAtIso: string;
  request: Readonly<{
    symbol: string;
    timeframe: string;
    sources: readonly string[];
    metrics: readonly string[];
  }>;
  distributions: readonly LookaheadDistribution[];
}>;

/**
 * Builds the deterministic cache file path for a given request. Sorts
 * `sources` and `metrics` so equivalent request shapes (same set,
 * different order) collapse to a single cache file.
 */
export function distributionsCachePath(args: {
  symbol: string;
  timeframe: Timeframe;
  sources: readonly LookaheadSource[];
  metrics: readonly LookaheadMetric[];
  cacheDir?: string;
}): string {
  const sortedSources = [...args.sources].sort();
  const sortedMetrics = [...args.metrics].sort();
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        symbol: args.symbol,
        timeframe: args.timeframe,
        sources: sortedSources,
        metrics: sortedMetrics,
      }),
    )
    .digest("hex")
    .slice(0, 12);
  const filename = `${args.symbol}_${args.timeframe}_${hash}.json`;
  return join(args.cacheDir ?? DEFAULT_CACHE_DIR, filename);
}

/**
 * Reads the cache file at `path`, returning `null` if it doesn't
 * exist, can't be parsed, or has the wrong version. Never throws on
 * cache miss — a cache miss is a normal, expected outcome.
 */
export async function readDistributionsCache(
  path: string,
): Promise<DistributionsCacheFile | null> {
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
  if (!isCacheFile(parsed)) {
    return null;
  }
  return parsed;
}

/**
 * Writes the cache file at `path`, creating its parent directory if
 * needed. Overwrites any existing file at that path.
 */
export async function writeDistributionsCache(
  path: string,
  data: DistributionsCacheFile,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
}

function isCacheFile(value: unknown): value is DistributionsCacheFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1) {
    return false;
  }
  if (typeof obj.computedAtIso !== "string") {
    return false;
  }
  if (!isFingerprint(obj.fingerprint)) {
    return false;
  }
  if (!Array.isArray(obj.distributions)) {
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
