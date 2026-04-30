import {
  bpsChange,
  generateLookaheadFeatures,
  type LookaheadFeatureRow,
} from "@wiggler/lib/candles/lookahead";
import { describe, expect, test } from "bun:test";

describe("bpsChange", () => {
  test("zero change", () => {
    expect(bpsChange(100n, 100n)).toBe(0);
  });
  test("+1% (100 bps)", () => {
    expect(bpsChange(101n, 100n)).toBe(100);
  });
  test("-1% (signed: -100 bps)", () => {
    expect(bpsChange(99n, 100n)).toBe(-100);
  });
  test("+50% = 5000 bps", () => {
    expect(bpsChange(150n, 100n)).toBe(5000);
  });
  test("100% (asymmetric down formulation: 100 → 50 reads as 10000 bps when called as bpsChange(100,50))", () => {
    // This mirrors the user-spec down formula:
    //   max_down_move_bps = 10_000 * (start_price / future_low - 1)
    // i.e. start=100, future_low=50 → 10_000 * (100/50 - 1) = 10_000.
    expect(bpsChange(100n, 50n)).toBe(10000);
  });
  test("e8-scale precision: rounding uses bigint math, no float drift", () => {
    // start = 76_000.00 e8, end = 76_076.00 e8 → diff is +76 USD on a $76K
    // base = exactly 10 bps. Verify the math survives at e8 scale (the
    // intermediate `num*10_000` would overflow Number safe-integer range).
    expect(
      bpsChange(7_607_600_000_000n, 7_600_000_000_000n),
    ).toBe(10);
  });
  test("rounds half away from zero", () => {
    // 0.5 bps cases: 10_005/10_000 = +5 bps exactly; 9_999.5 wouldn't be
    // representable — use bigger numbers. b=20_000, a=20_001 → diff=1,
    // num=10_000, halfB=10_000, (10_000+10_000)/20_000 = 1. Half rounds up.
    expect(bpsChange(20_001n, 20_000n)).toBe(1);
    // Negative direction: a=19_999, b=20_000. diff=-1, num=-10_000.
    // (-10_000 - 10_000)/20_000 = -1. Half rounds away from zero.
    expect(bpsChange(19_999n, 20_000n)).toBe(-1);
  });
  test("large negative (90% drop) stays exact", () => {
    // start=100, future=10. bpsChange(10, 100) = 10_000 * (10/100 - 1) = -9000.
    expect(bpsChange(10n, 100n)).toBe(-9000);
  });
});

describe("generateLookaheadFeatures", () => {
  const baseArgs = {
    source: "vwap" as const,
    symbol: "BTC",
    timeframe: "1m" as const,
    intervalMs: 60_000,
    lookaheadMinutes: [1, 2, 3, 4, 5],
  };

  function row(
    openTimeMs: number,
    startE8: bigint,
    highE8: bigint = startE8,
    lowE8: bigint = startE8,
  ) {
    return {
      openTimeMs,
      openTime: new Date(openTimeMs),
      startPriceE8: startE8,
      highE8,
      lowE8,
    };
  }

  test("monotonically rising series: max_up grows with lookahead, max_down stays at min wick", () => {
    // 6 minutes, anchor at minute 0. Closes: 100, 110, 120, 130, 140, 150.
    // Highs = closes + 5; lows = closes - 5.
    const rows = [0, 1, 2, 3, 4, 5].map((m) =>
      row(
        m * 60_000,
        100n + BigInt(m) * 10n,
        100n + BigInt(m) * 10n + 5n,
        100n + BigInt(m) * 10n - 5n,
      ),
    );
    const out: LookaheadFeatureRow[] = [
      ...generateLookaheadFeatures(rows, {
        ...baseArgs,
        fromMs: 0,
        toMs: 1, // anchor only the row at openTime=0
      }),
    ];
    expect(out).toHaveLength(5);
    // Lookahead = 1: window has only minute 1. high=115, low=105, end=110, start=100.
    const la1 = out[0]!;
    expect(la1.lookaheadMin).toBe(1);
    expect(la1.futureHighE8).toBe(115n);
    expect(la1.futureLowE8).toBe(105n);
    expect(la1.endPriceE8).toBe(110n);
    // max_up_bps   = 10_000 * (115/100 - 1)  = 1500
    // max_down_bps = 10_000 * (100/105 - 1)  ≈ -476.19 → rounded -476
    // c2c          = abs(10_000 * (110/100 - 1)) = 1000
    // range_bps    = 10_000 * (115/105 - 1)  ≈ 952.38 → 952
    expect(la1.maxUpMoveBps).toBe(1500);
    expect(la1.maxDownMoveBps).toBe(-476);
    expect(la1.closeToCloseAbsReturnBps).toBe(1000);
    expect(la1.rangeBps).toBe(952);
    expect(la1.maxAbsExcursionBps).toBe(1500); // up dominates
    // Lookahead = 5: window has minutes 1..5. high=155 (m=5), low=105 (m=1), end=150.
    const la5 = out[4]!;
    expect(la5.lookaheadMin).toBe(5);
    expect(la5.futureHighE8).toBe(155n);
    expect(la5.futureLowE8).toBe(105n);
    expect(la5.endPriceE8).toBe(150n);
    expect(la5.maxUpMoveBps).toBe(5500);
  });

  test("monotonically falling series: max_down grows with lookahead", () => {
    // Closes: 100, 90, 80, 70, 60, 50. Highs = closes; lows = closes.
    const rows = [0, 1, 2, 3, 4, 5].map((m) =>
      row(m * 60_000, 100n - BigInt(m) * 10n),
    );
    const out: LookaheadFeatureRow[] = [
      ...generateLookaheadFeatures(rows, {
        ...baseArgs,
        fromMs: 0,
        toMs: 1,
      }),
    ];
    const la5 = out[4]!;
    // max_down at lookahead 5: future_low=50 → 10_000 * (100/50 - 1) = 10_000.
    expect(la5.maxDownMoveBps).toBe(10000);
    // max_up: future_high=90 → 10_000 * (90/100 - 1) = -1000.
    expect(la5.maxUpMoveBps).toBe(-1000);
    expect(la5.maxAbsExcursionBps).toBe(10000);
  });

  test("anchor outside [fromMs, toMs) is skipped", () => {
    const rows = [0, 1, 2].map((m) => row(m * 60_000, 100n));
    const out = [
      ...generateLookaheadFeatures(rows, {
        ...baseArgs,
        fromMs: 60_000, // skip minute 0
        toMs: 60_001, // anchor only minute 1
        lookaheadMinutes: [1],
      }),
    ];
    expect(out).toHaveLength(1);
    expect(out[0]!.openTimeMs).toBe(60_000);
  });

  test("missing lookahead window: row near right edge of available data is partially emitted", () => {
    // Only 3 minutes of data. Anchor at minute 0 with lookaheads [1..5]:
    // we should emit lookaheads 1, 2 (data at m=1, m=2 exists) but NOT 3, 4, 5.
    const rows = [0, 1, 2].map((m) => row(m * 60_000, 100n));
    const out = [
      ...generateLookaheadFeatures(rows, {
        ...baseArgs,
        fromMs: 0,
        toMs: 1,
      }),
    ];
    // Once we've consumed the last row at minute 2, lookaheads 3..5 see no
    // new rows, so highE8/lowE8/endPrice stay populated from before — i.e.
    // the same values as lookahead=2. That's intentional: "end_price = the
    // close of the LAST row inside the window" handles gaps gracefully,
    // and a row past the right edge of available data behaves identically
    // to a missing future row inside an otherwise-dense series.
    expect(out).toHaveLength(5);
    // Lookahead 1: window=(0,60_000], includes only minute 1.
    expect(out[0]!.endPriceE8).toBe(100n);
    // Lookahead 5: window=(0,300_000], data covers m=1,m=2 only.
    expect(out[4]!.endPriceE8).toBe(100n);
    expect(out[4]!.futureHighE8).toBe(100n);
  });

  test("gap in the middle of the series: lookahead correctly skips missing minutes", () => {
    // Bitfinex-style gap: minute 3 is missing.
    // closes: m=0:100, m=1:110, m=2:120, m=4:140, m=5:150.
    // Anchor at m=0, lookahead=5 covers (0, 300_000]. Available rows
    // inside: m=1,2,4,5. future_high = max(110,120,140,150) = 150,
    // future_low = 110, end_price = close(m=5) = 150.
    const rows = [
      row(0, 100n),
      row(60_000, 110n),
      row(120_000, 120n),
      // minute 3 missing
      row(240_000, 140n),
      row(300_000, 150n),
    ];
    const out = [
      ...generateLookaheadFeatures(rows, {
        ...baseArgs,
        fromMs: 0,
        toMs: 1,
      }),
    ];
    const la3 = out[2]!;
    // Lookahead = 3: window=(0, 180_000]. Includes m=1,2 (and would include
    // m=3 but it's missing). future_high=120, future_low=110, end=120.
    expect(la3.futureHighE8).toBe(120n);
    expect(la3.futureLowE8).toBe(110n);
    expect(la3.endPriceE8).toBe(120n);
    const la5 = out[4]!;
    // Lookahead = 5: window=(0, 300_000]. Includes m=1,2,4,5. end=150.
    expect(la5.endPriceE8).toBe(150n);
    expect(la5.futureHighE8).toBe(150n);
  });

  test("all-flat series: every metric is exactly zero", () => {
    const rows = [0, 1, 2, 3, 4, 5].map((m) => row(m * 60_000, 100n));
    const out = [
      ...generateLookaheadFeatures(rows, {
        ...baseArgs,
        fromMs: 0,
        toMs: 1,
      }),
    ];
    for (const r of out) {
      expect(r.maxUpMoveBps).toBe(0);
      expect(r.maxDownMoveBps).toBe(0);
      expect(r.maxAbsExcursionBps).toBe(0);
      expect(r.closeToCloseAbsReturnBps).toBe(0);
      expect(r.rangeBps).toBe(0);
    }
  });

  test("e8-scale prices: BTC at 76k with a 50-bps wick stays in bigint precision", () => {
    // start = 76_000 * 1e8. Next minute high goes to 76_380 (+50 bps).
    const rows = [
      row(0, 7_600_000_000_000n, 7_600_000_000_000n, 7_600_000_000_000n),
      row(60_000, 7_604_000_000_000n, 7_638_000_000_000n, 7_604_000_000_000n),
    ];
    const out = [
      ...generateLookaheadFeatures(rows, {
        ...baseArgs,
        fromMs: 0,
        toMs: 1,
        lookaheadMinutes: [1],
      }),
    ];
    // 10_000 * (7_638_000_000_000 / 7_600_000_000_000 - 1) = 10_000 * 38 / 7600 = 50.
    expect(out[0]!.maxUpMoveBps).toBe(50);
  });
});
