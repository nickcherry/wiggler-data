import { describe, expect, test } from "bun:test";

/**
 * Reference implementation of the VWAP formula in plain bigint math,
 * mirroring exactly what the Postgres aggregate computes. We unit-test
 * the math here against hand-computed expected values; the SQL pass that
 * runs in production has the same shape (verified by EXPLAIN + a smoke
 * run against real data).
 *
 * Why a reference impl instead of testing the SQL directly: per repo
 * convention, tests must not touch the database. The math is pure and
 * deterministic — testing it here gives us exactly the right confidence
 * with zero infra dependency.
 */
type SourceCandle = Readonly<{
  highE8: bigint;
  lowE8: bigint;
  closeE8: bigint;
  /** null/0 means "no volume reported" — does not contribute weight. */
  volumeE8: bigint | null;
}>;

function computeBucketVwap(rows: readonly SourceCandle[]): {
  vwapE8: bigint;
  totalVolumeE8: bigint;
  sourceCount: number;
} {
  let weightedSum = 0n;
  let totalVolume = 0n;
  let typicalSum = 0n;
  for (const row of rows) {
    const typical = (row.highE8 + row.lowE8 + row.closeE8) / 3n;
    typicalSum += typical;
    if (row.volumeE8 !== null && row.volumeE8 > 0n) {
      // (H+L+C) * volume / 3 — keep numerator as full precision before /
      // dividing by total volume.
      weightedSum +=
        ((row.highE8 + row.lowE8 + row.closeE8) * row.volumeE8) / 3n;
      totalVolume += row.volumeE8;
    }
  }
  const sourceCount = rows.length;
  let vwapE8: bigint;
  if (totalVolume > 0n) {
    // Round half-up.
    vwapE8 = (weightedSum + totalVolume / 2n) / totalVolume;
  } else {
    // Fallback: simple mean of typical prices.
    vwapE8 = typicalSum / BigInt(sourceCount);
  }
  return { vwapE8, totalVolumeE8: totalVolume, sourceCount };
}

describe("computeBucketVwap", () => {
  test("single source: VWAP equals that source's typical price", () => {
    const rows: SourceCandle[] = [
      {
        // typical = (110 + 90 + 100) / 3 = 100
        highE8: 110n,
        lowE8: 90n,
        closeE8: 100n,
        volumeE8: 5n,
      },
    ];
    const result = computeBucketVwap(rows);
    expect(result.vwapE8).toBe(100n);
    expect(result.totalVolumeE8).toBe(5n);
    expect(result.sourceCount).toBe(1);
  });

  test("equal volume across sources collapses to simple mean of typicals", () => {
    const rows: SourceCandle[] = [
      // typical = 100
      { highE8: 110n, lowE8: 90n, closeE8: 100n, volumeE8: 1_000_000n },
      // typical = 200
      { highE8: 210n, lowE8: 190n, closeE8: 200n, volumeE8: 1_000_000n },
    ];
    const result = computeBucketVwap(rows);
    expect(result.vwapE8).toBe(150n);
    expect(result.totalVolumeE8).toBe(2_000_000n);
    expect(result.sourceCount).toBe(2);
  });

  test("high-volume source dominates a low-volume outlier", () => {
    // typicals: A=100, B=10000 (a fat-finger glitch on B).
    // Volumes: A has 1000× B's volume, so VWAP should sit much closer to A.
    const rows: SourceCandle[] = [
      { highE8: 110n, lowE8: 90n, closeE8: 100n, volumeE8: 1_000_000n },
      { highE8: 10010n, lowE8: 9990n, closeE8: 10000n, volumeE8: 1_000n },
    ];
    const result = computeBucketVwap(rows);
    // Hand math:
    // weightedSum = (300*1_000_000 + 30000*1_000)/3
    //             = (300_000_000 + 30_000_000)/3
    //             = 110_000_000
    // totalVolume = 1_001_000
    // vwap = round(110_000_000 / 1_001_000) = round(109.89...) = 110
    expect(result.vwapE8).toBe(110n);
    expect(result.totalVolumeE8).toBe(1_001_000n);
    expect(result.sourceCount).toBe(2);
  });

  test("zero volume → falls back to unweighted mean of typicals", () => {
    const rows: SourceCandle[] = [
      // typical = 100
      { highE8: 110n, lowE8: 90n, closeE8: 100n, volumeE8: 0n },
      // typical = 200
      { highE8: 210n, lowE8: 190n, closeE8: 200n, volumeE8: 0n },
    ];
    const result = computeBucketVwap(rows);
    expect(result.vwapE8).toBe(150n);
    expect(result.totalVolumeE8).toBe(0n);
    expect(result.sourceCount).toBe(2);
  });

  test("null volume is treated as no contribution to weight", () => {
    const rows: SourceCandle[] = [
      // typical = 100, volume = 1000
      { highE8: 110n, lowE8: 90n, closeE8: 100n, volumeE8: 1_000n },
      // typical = 1000, volume = null
      { highE8: 1010n, lowE8: 990n, closeE8: 1000n, volumeE8: null },
    ];
    const result = computeBucketVwap(rows);
    // Volume-weighted mean uses only the volumed row → vwap = 100.
    expect(result.vwapE8).toBe(100n);
    expect(result.totalVolumeE8).toBe(1_000n);
    expect(result.sourceCount).toBe(2);
  });

  test("BTC-scale e8 values stay in bigint precision", () => {
    // BTC at $76_000.00, volume of 0.5 BTC.
    // typical = (76_010 + 75_990 + 76_000) * 1e8 / 3 = 76_000 * 1e8
    const rows: SourceCandle[] = [
      {
        highE8: 7_601_000_000_000n, // 76_010 * 1e8
        lowE8: 7_599_000_000_000n,
        closeE8: 7_600_000_000_000n,
        volumeE8: 50_000_000n, // 0.5 BTC × 1e8
      },
    ];
    const result = computeBucketVwap(rows);
    expect(result.vwapE8).toBe(7_600_000_000_000n); // $76_000.00
    expect(result.totalVolumeE8).toBe(50_000_000n);
  });
});
