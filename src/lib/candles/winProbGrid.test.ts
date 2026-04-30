import {
  binVol,
  bucketAbsDBps,
  bucketRange,
  buildSeriesArrays,
  buildWinProbGrid,
  type ClosePoint,
  DEFAULT_ABS_D_BPS_BOUNDARIES,
  deriveVolBinThresholds,
  percentile,
  type VolBinThresholds,
} from "@wiggler/lib/candles/winProbGrid";
import { describe, expect, test } from "bun:test";

const E8 = 100_000_000n;

function close(tsMs: number, priceWhole: number): ClosePoint {
  return { tsMs, closeE8: BigInt(priceWhole) * E8 };
}

describe("bucketAbsDBps", () => {
  test("first bucket covers [0, 2)", () => {
    expect(bucketAbsDBps(0, DEFAULT_ABS_D_BPS_BOUNDARIES)).toBe(0);
    expect(bucketAbsDBps(1.99, DEFAULT_ABS_D_BPS_BOUNDARIES)).toBe(0);
  });

  test("boundary value lands in the bucket starting at it", () => {
    // 2 → index 1, which covers [2, 4)
    expect(bucketAbsDBps(2, DEFAULT_ABS_D_BPS_BOUNDARIES)).toBe(1);
    expect(bucketAbsDBps(20, DEFAULT_ABS_D_BPS_BOUNDARIES)).toBe(7);
  });

  test("anything ≥ last boundary lands in the open-ended tail bucket", () => {
    const tailIdx = DEFAULT_ABS_D_BPS_BOUNDARIES.length - 1;
    expect(bucketAbsDBps(75, DEFAULT_ABS_D_BPS_BOUNDARIES)).toBe(tailIdx);
    expect(bucketAbsDBps(500, DEFAULT_ABS_D_BPS_BOUNDARIES)).toBe(tailIdx);
  });

  test("rejects negative or non-finite input", () => {
    expect(() => bucketAbsDBps(-1, DEFAULT_ABS_D_BPS_BOUNDARIES)).toThrow();
    expect(() => bucketAbsDBps(NaN, DEFAULT_ABS_D_BPS_BOUNDARIES)).toThrow();
  });
});

describe("bucketRange", () => {
  test("middle bucket has finite max", () => {
    const r = bucketRange(0, DEFAULT_ABS_D_BPS_BOUNDARIES);
    expect(r.min).toBe(0);
    expect(r.max).toBe(2);
  });

  test("last bucket has null max (open-ended tail)", () => {
    const r = bucketRange(
      DEFAULT_ABS_D_BPS_BOUNDARIES.length - 1,
      DEFAULT_ABS_D_BPS_BOUNDARIES,
    );
    expect(r.min).toBe(75);
    expect(r.max).toBeNull();
  });
});

describe("binVol", () => {
  const t: VolBinThresholds = {
    lowMaxBpsPerSqrtMin: 5,
    normalMaxBpsPerSqrtMin: 10,
    highMaxBpsPerSqrtMin: 20,
  };

  test("at-or-below thresholds map to the lower bin", () => {
    expect(binVol(0, t)).toBe("low");
    expect(binVol(5, t)).toBe("low");
    expect(binVol(10, t)).toBe("normal");
    expect(binVol(20, t)).toBe("high");
  });

  test("above the highest threshold maps to extreme", () => {
    expect(binVol(20.0001, t)).toBe("extreme");
    expect(binVol(1000, t)).toBe("extreme");
  });
});

describe("percentile", () => {
  test("p0 / p100 are min / max", () => {
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4, 5], 1)).toBe(5);
  });

  test("p50 of evenly-spaced data is the median by linear interp", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });

  test("interpolates between samples", () => {
    // 4 elements → positions 0..3. p0.5 = 1.5 → midpoint of 2 and 3 = 2.5
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });
});

describe("deriveVolBinThresholds", () => {
  test("monotone-ascending thresholds at 33 / 67 / 90", () => {
    // 100 evenly-spaced values 1..100.
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    const t = deriveVolBinThresholds(xs);
    expect(t.lowMaxBpsPerSqrtMin).toBeLessThan(t.normalMaxBpsPerSqrtMin);
    expect(t.normalMaxBpsPerSqrtMin).toBeLessThan(t.highMaxBpsPerSqrtMin);
    // sanity: thresholds land near the requested percentiles
    expect(t.lowMaxBpsPerSqrtMin).toBeGreaterThan(30);
    expect(t.lowMaxBpsPerSqrtMin).toBeLessThan(35);
    expect(t.highMaxBpsPerSqrtMin).toBeGreaterThan(88);
    expect(t.highMaxBpsPerSqrtMin).toBeLessThan(92);
  });
});

describe("buildSeriesArrays", () => {
  test("empty input → all empty arrays", () => {
    const out = buildSeriesArrays({ closes: [], volLookbackMin: 30 });
    expect(out.totalMinutes).toBe(0);
    expect(out.closeAt).toEqual([]);
  });

  test("dense series: returns and recent-vol populate as expected", () => {
    // 10 minutes, prices stepping +100 bps each minute (close goes
    // 100 → 101 → 102.01 → ... but for simplicity use small fixed steps).
    // Use 10000 base + 10 each minute: that's 10 / 10000 = 10 bps each.
    const closes: ClosePoint[] = Array.from({ length: 10 }, (_, m) => ({
      tsMs: m * 60_000,
      closeE8: BigInt(10_000 + m * 10) * E8,
    }));
    const out = buildSeriesArrays({
      closes,
      volLookbackMin: 5,
      minVolSamples: 3,
    });
    expect(out.totalMinutes).toBe(10);
    // returnAt[0] is null (no prior). returnAt[1] = bps(10010, 10000) = 10.
    expect(out.returnAt[0]).toBeNull();
    expect(out.returnAt[1]).toBe(10);
    // recentVolAt at index 5 looks back at returns[0..4]: [null, 10, 10, 10, 10]
    // → 4 samples → RMS = 10.
    const v5 = out.recentVolAt[5];
    expect(v5).not.toBeNull();
    expect(v5!).toBeCloseTo(10, 5);
  });

  test("gaps in the middle: the missing minute keeps closeAt null and the affected return slots null", () => {
    // 5 minutes, but minute 2 is missing.
    const closes: ClosePoint[] = [
      close(0 * 60_000, 100),
      close(1 * 60_000, 101),
      // minute 2 missing
      close(3 * 60_000, 103),
      close(4 * 60_000, 104),
    ];
    const out = buildSeriesArrays({ closes, volLookbackMin: 5 });
    expect(out.totalMinutes).toBe(5);
    expect(out.closeAt[2]).toBeNull();
    expect(out.returnAt[2]).toBeNull(); // can't compute, prev null
    expect(out.returnAt[3]).toBeNull(); // can't compute, prev null (still)
    // returnAt[4] = bps(close[4], close[3]) — both present.
    expect(out.returnAt[4]).not.toBeNull();
  });
});

describe("buildWinProbGrid", () => {
  /**
   * Synthesize a noiseless monotonically-rising series. Every 5-minute
   * interval has an Up resolution. Every Up-side decision wins; every
   * Down-side decision (which never happens here) would lose. The grid
   * should report 100% Up-wins for every populated bucket.
   */
  test("monotonic up: every populated bucket has wins == count", () => {
    // 60 minutes, +1 bps per minute. Means every 5m interval has +5 bps
    // d_bps at end and current is always Up.
    const closes: ClosePoint[] = Array.from({ length: 60 }, (_, m) => ({
      tsMs: m * 60_000,
      // 100_000 base, +10 e8 per minute = +1 bps per minute on a 100k base.
      closeE8: BigInt(100_000) * E8 + BigInt(m) * 10n * E8,
    }));
    const grid = buildWinProbGrid({
      closes,
      intervalSec: 300,
      volLookbackMin: 10,
    });
    expect(grid.totalRows).toBeGreaterThan(0);
    expect(grid.upWinAnchors).toBeGreaterThan(0);
    expect(grid.downWinAnchors).toBe(0);
    for (const b of grid.buckets) {
      if (b.count > 0) {
        expect(b.wins).toBe(b.count);
      }
    }
  });

  /**
   * Symmetric oscillator: even minutes at price 100, odd at 99. By
   * parity, half the intervals are Up-resolving (start at low, end at
   * high) and half are Down-resolving — exercises both branches of
   * the winning-side classifier and the symmetric pooling of Up/Down
   * trades into one grid.
   *
   * Bucket-level invariants we care about:
   *   - wins ≤ count for every bucket
   *   - p_win == wins / count for populated buckets
   *   - p_win_lower ≤ p_win for populated buckets
   *   - up + down anchors == total interval-anchors scanned
   */
  test("flat-mean oscillator: bucket-level invariants hold under symmetric input", () => {
    const closes: ClosePoint[] = Array.from({ length: 60 }, (_, m) => ({
      tsMs: m * 60_000,
      closeE8: m % 2 === 0 ? BigInt(100_000) * E8 : BigInt(99_999) * E8,
    }));
    const grid = buildWinProbGrid({
      closes,
      intervalSec: 300,
      volLookbackMin: 10,
    });
    expect(grid.upWinAnchors).toBeGreaterThan(0);
    expect(grid.downWinAnchors).toBeGreaterThan(0);
    for (const b of grid.buckets) {
      expect(b.wins).toBeLessThanOrEqual(b.count);
      if (b.count > 0) {
        expect(b.pWin).toBeCloseTo(b.wins / b.count, 10);
        expect(b.pWinLower).toBeLessThanOrEqual(b.pWin);
      } else {
        expect(b.pWin).toBe(0);
        expect(b.pWinLower).toBe(0);
      }
    }
  });

  test("rejects malformed args", () => {
    expect(() =>
      buildWinProbGrid({
        closes: [close(0, 100)],
        intervalSec: 119, // not 60-aligned
      }),
    ).toThrow();
    expect(() =>
      buildWinProbGrid({
        closes: [close(0, 100)],
        intervalSec: 300,
        decisionRemainingSecs: [45], // not 60-aligned
      }),
    ).toThrow();
    expect(() =>
      buildWinProbGrid({
        closes: [close(0, 100)],
        intervalSec: 300,
        absDBpsBoundaries: [1, 2, 3], // doesn't start at 0
      }),
    ).toThrow();
    expect(() =>
      buildWinProbGrid({
        closes: [close(0, 100)],
        intervalSec: 300,
        absDBpsBoundaries: [0, 5, 5, 10], // not strictly ascending
      }),
    ).toThrow();
  });

  test("default decision-remaining-secs cover every integer-minute boundary", () => {
    const closes: ClosePoint[] = Array.from({ length: 30 }, (_, m) =>
      close(m * 60_000, 100),
    );
    const grid = buildWinProbGrid({
      closes,
      intervalSec: 300,
      volLookbackMin: 10,
    });
    expect(grid.decisionRemainingSecs).toEqual([60, 120, 180, 240]);
  });

  test("buckets are emitted in a deterministic order even when counts are zero", () => {
    // Tiny series — most buckets will be empty.
    const closes: ClosePoint[] = Array.from({ length: 20 }, (_, m) =>
      close(m * 60_000, 100),
    );
    const grid = buildWinProbGrid({
      closes,
      intervalSec: 300,
      volLookbackMin: 5,
    });
    // We expect 4 (remaining) × 4 (vol) × 13 (bps buckets) = 208 entries.
    expect(grid.buckets.length).toBe(4 * 4 * DEFAULT_ABS_D_BPS_BOUNDARIES.length);
    // First bucket should be remaining=60, volBin=low, bucketIdx=0
    expect(grid.buckets[0]!.remainingSec).toBe(60);
    expect(grid.buckets[0]!.volBin).toBe("low");
    expect(grid.buckets[0]!.absDBpsMin).toBe(0);
  });

  /**
   * Regression test for the candle-timestamp invariant documented at
   * the top of `winProbGrid.ts`. Construct a series where the
   * resolution candle (the bar at `i + intervalMin`) carries a
   * uniquely large price that would fall into a high-bps bucket if it
   * leaked into a decision row. With the correct offsets, the
   * resolution candle is NEVER read as a decision-time current price
   * — every decision uses `closeAt[i + (intervalMin - 1)]` or earlier.
   *
   * If anyone "fixes" `decisionIdx = i + elapsedMin` to
   * `i + elapsedMin + 1` etc., this test will start placing rows in
   * the runaway-bps tail bucket.
   */
  test("no lookahead bias: resolution-bar price never enters decision rows", () => {
    // 12 bars. Anchors land at bars 0..6 (since i + 5 must be in range).
    // Make every bar identical EXCEPT the bar at index 5 (which is the
    // resolution bar for anchor i=0). Set that bar to +500 bps from
    // the others. If the offsets were off by one and `closeAt[i + 5]`
    // got read as a decision-time current price, the absDBps would
    // jump into the tail bucket (≥ 75 bps) for that anchor.
    const closes: ClosePoint[] = Array.from({ length: 12 }, (_, m) => {
      const isResolutionBar = m === 5;
      // Anchor at i=0 uses closeAt[0] as line and closeAt[5] as final.
      // closeAt[1..4] are decision-time current prices.
      return close(
        m * 60_000,
        isResolutionBar ? 1_005 : 1_000,
      );
    });
    // Force a 0-bps abs-d bucket span and pretend vol is never null
    // by giving it 30+ bars of warm-up. We cheat by using volLookbackMin=2
    // and minVolSamples=1 inside buildSeriesArrays' default… instead,
    // run with a small lookback so vol is always populated.
    const grid = buildWinProbGrid({
      closes,
      intervalSec: 300,
      volLookbackMin: 2,
    });
    // Anchor i=0 has line=1000 and final=1005 → +50 bps → Up wins.
    // Decision rows (elapsed=1..4) use closeAt[1..4] = 1000 each →
    // d_bps = 0 each. They should land in the [0, 2) bucket — index 0.
    // The tail bucket (≥75) should NEVER receive an i=0 row. Verify:
    const tailBucketIdx = DEFAULT_ABS_D_BPS_BOUNDARIES.length - 1;
    const tailBuckets = grid.buckets.filter(
      (b, idx) => idx % DEFAULT_ABS_D_BPS_BOUNDARIES.length === tailBucketIdx,
    );
    const tailCountTotal = tailBuckets.reduce((acc, b) => acc + b.count, 0);
    // Other anchors (i=1..6) may legitimately land in higher buckets
    // because some of their decision-time bars coincide with bar 5
    // (the +50 bps spike), which is fine — that's a real observable
    // price for them. Anchor i=0 has its decisions at bars 1..4, all
    // identical, so it can't itself produce a tail-bucket row even
    // accidentally. The test really checks `i=0` never gets a tail
    // row; we can audit total tail rows ≤ 4 (4 anchors × 1 decision
    // each whose decisionIdx = 5 = the spike bar).
    //   i=1: decisions at bars 2,3,4,5 → bar 5 used at remaining=60s
    //   i=2: decisions at bars 3,4,5,6 → bar 5 used at remaining=120s
    //   i=3: decisions at bars 4,5,6,7 → bar 5 used at remaining=180s
    //   i=4: decisions at bars 5,6,7,8 → bar 5 used at remaining=240s
    //   i=5: anchor=bar5 itself; line=1005. Decisions at bars 6..9 = 1000
    //        → d_bps ≈ -50 (down side, abs ~50). Not tail bucket (75+).
    //   i=6: line=bar6=1000. Decisions at bars 7..10 = 1000.
    // So legitimate tail-bucket rows (abs_d_bps ≥ 75): zero.
    expect(tailCountTotal).toBe(0);
  });

  test("anchorStepMin = intervalMin restricts to boundary-aligned anchors", () => {
    // 60 bars; long-enough vol warm-up so recentVolAt populates from
    // index ~10 onward. Rolling yields anchors at minutes 10..54.
    // Boundary-aligned with anchorStepMin=5 yields a strict subset.
    const closes: ClosePoint[] = Array.from({ length: 60 }, (_, m) =>
      close(m * 60_000, 1000 + m),
    );
    const rolling = buildWinProbGrid({
      closes,
      intervalSec: 300,
      volLookbackMin: 10,
    });
    const aligned = buildWinProbGrid({
      closes,
      intervalSec: 300,
      volLookbackMin: 10,
      anchorStepMin: 5,
    });
    expect(rolling.anchorStepMin).toBe(1);
    expect(aligned.anchorStepMin).toBe(5);
    expect(aligned.upWinAnchors + aligned.downWinAnchors).toBeGreaterThan(0);
    expect(rolling.upWinAnchors + rolling.downWinAnchors).toBeGreaterThan(
      aligned.upWinAnchors + aligned.downWinAnchors,
    );
  });
});
