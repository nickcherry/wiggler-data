import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fingerprintsMatch,
  type LookaheadFingerprint,
  type LookaheadStatsRow,
} from "@wiggler/lib/candles/lookaheadStats";
import {
  type MetricCacheFile,
  metricCachePath,
  readMetricCache,
  writeMetricCache,
} from "@wiggler/lib/candles/lookaheadStatsCache";
import { describe, expect, test } from "bun:test";

describe("metricCachePath", () => {
  test("nests files by symbol+timeframe directory and uses metric as filename", () => {
    const path = metricCachePath({
      symbol: "BTC",
      timeframe: "1m",
      metric: "max_abs_excursion_bps",
      cacheDir: "tmp/distributions",
    });
    expect(path).toBe(
      "tmp/distributions/BTC_1m/max_abs_excursion_bps.json",
    );
  });

  test("different metric → different file (so each metric invalidates independently)", () => {
    const a = metricCachePath({
      symbol: "BTC",
      timeframe: "1m",
      metric: "range_bps",
    });
    const b = metricCachePath({
      symbol: "BTC",
      timeframe: "1m",
      metric: "max_up_move_bps",
    });
    expect(a).not.toBe(b);
  });

  test("source filter does NOT affect the path — same metric reuses the cache regardless of which sources the user filters to", () => {
    // The whole point of per-metric caching with client-side source
    // filtering: the same file backs both `--sources coinbase` and
    // `--sources binance` requests for the same metric.
    const path = metricCachePath({
      symbol: "BTC",
      timeframe: "1m",
      metric: "range_bps",
    });
    expect(path.endsWith("range_bps.json")).toBe(true);
    expect(path.includes("coinbase")).toBe(false);
    expect(path.includes("binance")).toBe(false);
  });
});

describe("fingerprintsMatch", () => {
  test("same shape → matches", () => {
    const a: LookaheadFingerprint = { rowCount: 100, latestOpenTimeMs: 1_700_000_000_000 };
    const b: LookaheadFingerprint = { rowCount: 100, latestOpenTimeMs: 1_700_000_000_000 };
    expect(fingerprintsMatch(a, b)).toBe(true);
  });

  test("different rowCount → no match (cache invalidates after re-run)", () => {
    const a: LookaheadFingerprint = { rowCount: 100, latestOpenTimeMs: 1_700_000_000_000 };
    const b: LookaheadFingerprint = { rowCount: 101, latestOpenTimeMs: 1_700_000_000_000 };
    expect(fingerprintsMatch(a, b)).toBe(false);
  });

  test("different latestOpenTimeMs → no match (cache invalidates after fresh data)", () => {
    const a: LookaheadFingerprint = { rowCount: 100, latestOpenTimeMs: 1_700_000_000_000 };
    const b: LookaheadFingerprint = { rowCount: 100, latestOpenTimeMs: 1_700_000_060_000 };
    expect(fingerprintsMatch(a, b)).toBe(false);
  });

  test("null vs number latestOpenTimeMs → no match", () => {
    const a: LookaheadFingerprint = { rowCount: 0, latestOpenTimeMs: null };
    const b: LookaheadFingerprint = { rowCount: 0, latestOpenTimeMs: 1_700_000_000_000 };
    expect(fingerprintsMatch(a, b)).toBe(false);
  });
});

describe("read/write metric cache", () => {
  function makeFile(): MetricCacheFile {
    const rows: LookaheadStatsRow[] = [
      {
        source: "coinbase",
        lookaheadMin: 1,
        count: 525_132,
        mean: 7,
        p50: 5,
        p75: 8,
        p80: 10,
        p90: 13,
        p95: 18,
        p97_5: 23,
        p99: 30,
        p99_5: 37,
        max: 382,
      },
      {
        source: "binance",
        lookaheadMin: 1,
        count: 525_607,
        mean: 2,
        p50: 0,
        p75: 0,
        p80: 0,
        p90: 6,
        p95: 15,
        p97_5: 27,
        p99: 38,
        p99_5: 45,
        max: 275,
      },
    ];
    return {
      version: 2,
      fingerprint: { rowCount: 12_731_107, latestOpenTimeMs: 1_777_542_120_000 },
      computedAtIso: "2026-04-30T10:30:00.000Z",
      symbol: "BTC",
      timeframe: "1m",
      metric: "range_bps",
      rows,
    };
  }

  test("round-trips a metric cache file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wiggler-cache-test-"));
    const path = join(dir, "range_bps.json");
    const original = makeFile();
    await writeMetricCache(path, original);
    const loaded = await readMetricCache(path, original.fingerprint);
    expect(loaded).not.toBeNull();
    expect(loaded?.metric).toBe("range_bps");
    expect(loaded?.rows).toEqual(original.rows);
  });

  test("missing file → null (cache miss is not an error)", async () => {
    const path = join(tmpdir(), `wiggler-cache-test-missing-${Date.now()}.json`);
    expect(
      await readMetricCache(path, { rowCount: 0, latestOpenTimeMs: null }),
    ).toBeNull();
  });

  test("malformed JSON → null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wiggler-cache-test-"));
    const path = join(dir, "broken.json");
    await Bun.write(path, "{not valid json");
    expect(
      await readMetricCache(path, { rowCount: 0, latestOpenTimeMs: null }),
    ).toBeNull();
  });

  test("wrong version → null (forces recompute)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wiggler-cache-test-"));
    const path = join(dir, "old-version.json");
    await Bun.write(
      path,
      JSON.stringify({
        version: 1,
        fingerprint: { rowCount: 0, latestOpenTimeMs: null },
        computedAtIso: "2025-01-01T00:00:00.000Z",
        symbol: "BTC",
        timeframe: "1m",
        metric: "range_bps",
        rows: [],
      }),
    );
    expect(
      await readMetricCache(path, { rowCount: 0, latestOpenTimeMs: null }),
    ).toBeNull();
  });

  test("fingerprint mismatch → null (cache invalidates when underlying data moves)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wiggler-cache-test-"));
    const path = join(dir, "fingerprint-mismatch.json");
    const original = makeFile();
    await writeMetricCache(path, original);

    // Same file, but the live DB now reports a different fingerprint.
    const loaded = await readMetricCache(path, {
      rowCount: original.fingerprint.rowCount + 1, // one new row added
      latestOpenTimeMs: original.fingerprint.latestOpenTimeMs,
    });
    expect(loaded).toBeNull();
  });
});
