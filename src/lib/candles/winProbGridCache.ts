import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Timeframe } from "@wiggler/constants/candles";
import type { LookaheadSource } from "@wiggler/lib/candles/lookahead";
import type { WigglerProbGridConfig } from "@wiggler/lib/candles/winProbGridConfig";

/**
 * On-disk JSON cache for the win-probability grid config artifact.
 * One file per `(asset, interval_sec, label_source, anchor_mode)`:
 *
 *   tmp/win-prob-grid/{ASSET}_{INTERVAL_SEC}s_{LABEL_SOURCE}_{anchor_mode}.json
 *
 * The file IS the deliverable wiggler reads. Keeping it under `tmp/`
 * (gitignored) matches the convention for generated artifacts. Promote
 * a frozen snapshot into a wiggler-side checked-in path when shipping.
 *
 * Cache validity: a `WinProbGridFingerprint` (input rowcount + last
 * interval-end open-time) is recorded at write time and compared
 * against the live DB at read time. Anything that changes the upstream
 * candle data invalidates the cache.
 */

const DEFAULT_CACHE_DIR = "tmp/win-prob-grid";

export type WinProbGridFingerprint = Readonly<{
  rowCount: number;
  latestIntervalEndMs: number | null;
}>;

export function fingerprintsMatch(
  a: WinProbGridFingerprint,
  b: WinProbGridFingerprint,
): boolean {
  return (
    a.rowCount === b.rowCount && a.latestIntervalEndMs === b.latestIntervalEndMs
  );
}

export type WinProbGridCacheFile = Readonly<{
  cache_version: 1;
  fingerprint: WinProbGridFingerprint;
  config: WigglerProbGridConfig;
}>;

export function winProbGridCachePath(args: {
  symbol: string;
  timeframe: Timeframe;
  intervalSec: number;
  labelSource: LookaheadSource;
  anchorMode: "rolling" | "boundary";
  cacheDir?: string;
}): string {
  return join(
    args.cacheDir ?? DEFAULT_CACHE_DIR,
    `${args.symbol}_${args.timeframe}_${args.intervalSec}s_${args.labelSource}_${args.anchorMode}.json`,
  );
}

export async function readWinProbGridCache(
  path: string,
  expected: WinProbGridFingerprint,
): Promise<WinProbGridCacheFile | null> {
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
  if (!fingerprintsMatch(parsed.fingerprint, expected)) {
    return null;
  }
  return parsed;
}

export async function writeWinProbGridCache(
  path: string,
  data: WinProbGridCacheFile,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
}

function isCacheFile(value: unknown): value is WinProbGridCacheFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (obj.cache_version !== 1) {
    return false;
  }
  if (!isFingerprint(obj.fingerprint)) {
    return false;
  }
  if (typeof obj.config !== "object" || obj.config === null) {
    return false;
  }
  return true;
}

function isFingerprint(value: unknown): value is WinProbGridFingerprint {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.rowCount !== "number") {
    return false;
  }
  if (
    obj.latestIntervalEndMs !== null &&
    typeof obj.latestIntervalEndMs !== "number"
  ) {
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
