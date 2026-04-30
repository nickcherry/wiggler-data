import { wilsonLowerBound } from "@wiggler/lib/candles/wilsonInterval";
import { describe, expect, test } from "bun:test";

describe("wilsonLowerBound", () => {
  test("count=0 → 0 (no evidence)", () => {
    expect(wilsonLowerBound({ wins: 0, count: 0 })).toBe(0);
  });

  test("0/100 → 0 lower bound", () => {
    expect(wilsonLowerBound({ wins: 0, count: 100 })).toBe(0);
  });

  test("100/100 stays well below 1 — small samples must not look certain", () => {
    // Whole point of using Wilson: a 17/17 bucket is NOT 100% confident.
    const lo = wilsonLowerBound({ wins: 17, count: 17 });
    expect(lo).toBeGreaterThan(0.7);
    expect(lo).toBeLessThan(0.95);
  });

  test("larger sample with same p_hat → tighter (higher) lower bound", () => {
    // Both buckets have p_hat = 0.95 but n differs by 100x.
    const small = wilsonLowerBound({ wins: 19, count: 20 });
    const big = wilsonLowerBound({ wins: 1900, count: 2000 });
    expect(big).toBeGreaterThan(small);
    expect(big).toBeGreaterThan(0.93);
    expect(small).toBeLessThan(0.85);
  });

  test("p_hat = 0.5, n = 100, z = 1.96 ≈ 0.404 (textbook value)", () => {
    // Standard textbook Wilson interval check: 50/100 at 95% CI.
    // Wilson ≈ [0.404, 0.596].
    const lo = wilsonLowerBound({ wins: 50, count: 100, z: 1.96 });
    expect(lo).toBeGreaterThan(0.4);
    expect(lo).toBeLessThan(0.41);
  });

  test("higher z (more conservative) → lower lower-bound", () => {
    const wide = wilsonLowerBound({ wins: 90, count: 100, z: 2.5758 });
    const narrow = wilsonLowerBound({ wins: 90, count: 100, z: 1.6449 });
    expect(narrow).toBeGreaterThan(wide);
  });

  test("monotone in wins for fixed count", () => {
    const a = wilsonLowerBound({ wins: 80, count: 100 });
    const b = wilsonLowerBound({ wins: 90, count: 100 });
    expect(b).toBeGreaterThan(a);
  });

  test("rejects invalid inputs", () => {
    expect(() => wilsonLowerBound({ wins: -1, count: 10 })).toThrow();
    expect(() => wilsonLowerBound({ wins: 11, count: 10 })).toThrow();
    expect(() => wilsonLowerBound({ wins: NaN, count: 10 })).toThrow();
  });
});
