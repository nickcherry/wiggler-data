import {
  assertWellFormedFiveMinuteWindow,
  getFiveMinuteWindow,
  getFiveMinuteWindowSeries,
  getNextFiveMinuteWindow,
  isWithinWindow,
} from "@wiggler/lib/domain/marketWindow";
import { describe, expect, test } from "bun:test";

describe("getFiveMinuteWindow", () => {
  test("aligns to 5-minute boundary", () => {
    const ts = Date.UTC(2026, 3, 29, 15, 17, 23, 456);
    const window = getFiveMinuteWindow(new Date(ts));
    expect(window.startMs).toBe(Date.UTC(2026, 3, 29, 15, 15, 0, 0));
    expect(window.endMs).toBe(Date.UTC(2026, 3, 29, 15, 20, 0, 0));
  });

  test("aligns when already on boundary", () => {
    const ts = Date.UTC(2026, 3, 29, 15, 15, 0, 0);
    const window = getFiveMinuteWindow(new Date(ts));
    expect(window.startMs).toBe(ts);
  });
});

describe("getNextFiveMinuteWindow", () => {
  test("returns the immediately following window", () => {
    const ts = Date.UTC(2026, 3, 29, 15, 17, 23, 0);
    const window = getNextFiveMinuteWindow(new Date(ts));
    expect(window.startMs).toBe(Date.UTC(2026, 3, 29, 15, 20, 0, 0));
  });
});

describe("getFiveMinuteWindowSeries", () => {
  test("returns lookback + current + lookahead windows", () => {
    const ts = Date.UTC(2026, 3, 29, 15, 17, 23, 0);
    const series = getFiveMinuteWindowSeries({
      reference: new Date(ts),
      lookback: 1,
      lookahead: 2,
    });
    expect(series).toHaveLength(4);
    expect(series[0]!.startMs).toBe(Date.UTC(2026, 3, 29, 15, 10, 0, 0));
    expect(series[3]!.startMs).toBe(Date.UTC(2026, 3, 29, 15, 25, 0, 0));
  });
});

describe("assertWellFormedFiveMinuteWindow", () => {
  test("accepts a 5-minute aligned window", () => {
    expect(() =>
      assertWellFormedFiveMinuteWindow({
        startMs: Date.UTC(2026, 3, 29, 15, 15, 0, 0),
        endMs: Date.UTC(2026, 3, 29, 15, 20, 0, 0),
      }),
    ).not.toThrow();
  });
  test("rejects misaligned start", () => {
    expect(() =>
      assertWellFormedFiveMinuteWindow({
        startMs: Date.UTC(2026, 3, 29, 15, 16, 0, 0),
        endMs: Date.UTC(2026, 3, 29, 15, 21, 0, 0),
      }),
    ).toThrow();
  });
  test("rejects wrong duration", () => {
    expect(() =>
      assertWellFormedFiveMinuteWindow({
        startMs: Date.UTC(2026, 3, 29, 15, 15, 0, 0),
        endMs: Date.UTC(2026, 3, 29, 15, 25, 0, 0),
      }),
    ).toThrow();
  });
});

describe("isWithinWindow", () => {
  const window = {
    startMs: Date.UTC(2026, 3, 29, 15, 15, 0, 0),
    endMs: Date.UTC(2026, 3, 29, 15, 20, 0, 0),
  };
  test("inside window", () => {
    expect(isWithinWindow(window, Date.UTC(2026, 3, 29, 15, 17, 0, 0))).toBe(true);
  });
  test("at start", () => {
    expect(isWithinWindow(window, window.startMs)).toBe(true);
  });
  test("at end is exclusive", () => {
    expect(isWithinWindow(window, window.endMs)).toBe(false);
  });
});
