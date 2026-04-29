import {
  checkComplementPrices,
  checkCrossed,
} from "@wiggler/lib/audit/validateBook";
import { describe, expect, test } from "bun:test";

describe("checkCrossed", () => {
  test("not crossed when bid < ask", () => {
    const result = checkCrossed({
      bestBidE6: 480_000n,
      bestAskE6: 510_000n,
      spreadE6: 30_000n,
    });
    expect(result.crossed).toBe(false);
  });
  test("crossed when bid >= ask", () => {
    const result = checkCrossed({
      bestBidE6: 510_000n,
      bestAskE6: 480_000n,
      spreadE6: -30_000n,
    });
    expect(result.crossed).toBe(true);
  });
  test("not crossed if missing side", () => {
    const result = checkCrossed({ bestBidE6: null, bestAskE6: 510_000n, spreadE6: null });
    expect(result.crossed).toBe(false);
  });
});

describe("checkComplementPrices", () => {
  test("complement check passes for tight book", () => {
    const result = checkComplementPrices({
      up: { bestBidE6: 480_000n, bestAskE6: 510_000n, spreadE6: 30_000n },
      down: { bestBidE6: 490_000n, bestAskE6: 520_000n, spreadE6: 30_000n },
    });
    expect(result.ok).toBe(true);
  });
  test("returns ok when one side is missing", () => {
    const result = checkComplementPrices({
      up: { bestBidE6: 480_000n, bestAskE6: null, spreadE6: null },
      down: { bestBidE6: 490_000n, bestAskE6: 520_000n, spreadE6: 30_000n },
    });
    expect(result.ok).toBe(true);
  });
  test("flags violating bids", () => {
    const result = checkComplementPrices({
      up: { bestBidE6: 700_000n, bestAskE6: 720_000n, spreadE6: 20_000n },
      down: { bestBidE6: 700_000n, bestAskE6: 720_000n, spreadE6: 20_000n },
    });
    expect(result.ok).toBe(false);
  });
});
