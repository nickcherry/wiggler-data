import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fingerprintsMatch,
  type LookaheadFingerprint,
} from "@wiggler/lib/candles/lookaheadStats";
import {
  distributionsCachePath,
  readDistributionsCache,
  writeDistributionsCache,
} from "@wiggler/lib/candles/lookaheadStatsCache";
import { describe, expect, test } from "bun:test";

describe("distributionsCachePath", () => {
  test("collapses different orderings of the same set to one path", () => {
    // The user can pass `coinbase,vwap` or `vwap,coinbase` and get the
    // same result; the cache must not duplicate work for the same
    // logical request.
    const a = distributionsCachePath({
      symbol: "BTC",
      timeframe: "1m",
      sources: ["coinbase", "vwap"],
      metrics: ["range_bps", "max_abs_excursion_bps"],
    });
    const b = distributionsCachePath({
      symbol: "BTC",
      timeframe: "1m",
      sources: ["vwap", "coinbase"],
      metrics: ["max_abs_excursion_bps", "range_bps"],
    });
    expect(a).toBe(b);
  });

  test("different symbol → different path", () => {
    const a = distributionsCachePath({
      symbol: "BTC",
      timeframe: "1m",
      sources: ["coinbase"],
      metrics: ["range_bps"],
    });
    const b = distributionsCachePath({
      symbol: "ETH",
      timeframe: "1m",
      sources: ["coinbase"],
      metrics: ["range_bps"],
    });
    expect(a).not.toBe(b);
  });

  test("different sources → different path", () => {
    const a = distributionsCachePath({
      symbol: "BTC",
      timeframe: "1m",
      sources: ["coinbase"],
      metrics: ["range_bps"],
    });
    const b = distributionsCachePath({
      symbol: "BTC",
      timeframe: "1m",
      sources: ["binance"],
      metrics: ["range_bps"],
    });
    expect(a).not.toBe(b);
  });

  test("filename includes symbol and timeframe up front for human scanning", () => {
    const path = distributionsCachePath({
      symbol: "BTC",
      timeframe: "5m",
      sources: ["coinbase"],
      metrics: ["range_bps"],
    });
    const filename = path.split("/").pop() ?? "";
    expect(filename.startsWith("BTC_5m_")).toBe(true);
    expect(filename.endsWith(".json")).toBe(true);
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

describe("read/write distributions cache", () => {
  test("round-trips a cache file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wiggler-cache-test-"));
    const path = join(dir, "BTC_1m_test.json");
    const original = {
      version: 1 as const,
      fingerprint: { rowCount: 12_731_107, latestOpenTimeMs: 1_777_542_120_000 },
      computedAtIso: "2026-04-30T10:30:00.000Z",
      request: {
        symbol: "BTC",
        timeframe: "1m",
        sources: ["coinbase", "vwap"] as const,
        metrics: ["range_bps"] as const,
      },
      distributions: [
        {
          metric: "range_bps" as const,
          rows: [
            {
              source: "coinbase" as const,
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
          ],
        },
      ],
    };
    await writeDistributionsCache(path, original);
    const loaded = await readDistributionsCache(path);
    expect(loaded).not.toBeNull();
    expect(loaded?.fingerprint).toEqual(original.fingerprint);
    expect(loaded?.distributions).toEqual(original.distributions);
  });

  test("missing file → null (cache miss is not an error)", async () => {
    const path = join(tmpdir(), `wiggler-cache-test-missing-${Date.now()}.json`);
    expect(await readDistributionsCache(path)).toBeNull();
  });

  test("malformed JSON → null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wiggler-cache-test-"));
    const path = join(dir, "broken.json");
    await Bun.write(path, "{not valid json");
    expect(await readDistributionsCache(path)).toBeNull();
  });

  test("wrong version → null (forces recompute)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wiggler-cache-test-"));
    const path = join(dir, "old-version.json");
    await Bun.write(
      path,
      JSON.stringify({
        version: 99,
        fingerprint: { rowCount: 0, latestOpenTimeMs: null },
        computedAtIso: "2025-01-01T00:00:00.000Z",
        request: { symbol: "BTC", timeframe: "1m", sources: [], metrics: [] },
        distributions: [],
      }),
    );
    expect(await readDistributionsCache(path)).toBeNull();
  });
});
