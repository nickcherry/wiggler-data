import { TopOfBookTracker } from "@wiggler/lib/prices/topOfBookTracker";
import { describe, expect, test } from "bun:test";

describe("TopOfBookTracker", () => {
  test("returns null sides before any input", () => {
    const t = new TopOfBookTracker();
    expect(t.topOfBook()).toEqual({ bidE8: null, askE8: null });
  });

  test("computes top-of-book as max bid / min ask", () => {
    const t = new TopOfBookTracker();
    t.setBid(100n);
    t.setBid(101n);
    t.setBid(99n);
    t.setAsk(105n);
    t.setAsk(103n);
    t.setAsk(104n);
    expect(t.topOfBook()).toEqual({ bidE8: 101n, askE8: 103n });
  });

  test("removeBid / removeAsk drop levels and the next-best surfaces", () => {
    const t = new TopOfBookTracker();
    t.setBid(100n);
    t.setBid(101n);
    t.setAsk(103n);
    t.setAsk(104n);
    t.removeBid(101n);
    t.removeAsk(103n);
    expect(t.topOfBook()).toEqual({ bidE8: 100n, askE8: 104n });
  });

  test("resetSnapshot replaces book state", () => {
    const t = new TopOfBookTracker();
    t.setBid(100n);
    t.setAsk(110n);
    t.resetSnapshot({ bids: [200n, 199n], asks: [210n, 211n] });
    expect(t.topOfBook()).toEqual({ bidE8: 200n, askE8: 210n });
  });

  test("removing the only level on a side returns null for that side", () => {
    const t = new TopOfBookTracker();
    t.setBid(100n);
    t.removeBid(100n);
    expect(t.topOfBook()).toEqual({ bidE8: null, askE8: null });
  });

  test("setBid is idempotent (same price tracked once)", () => {
    const t = new TopOfBookTracker();
    t.setBid(100n);
    t.setBid(100n);
    t.removeBid(100n);
    expect(t.topOfBook()).toEqual({ bidE8: null, askE8: null });
  });

  test("removing a price not present is a no-op", () => {
    const t = new TopOfBookTracker();
    t.setBid(100n);
    t.removeBid(999n);
    expect(t.topOfBook()).toEqual({ bidE8: 100n, askE8: null });
  });
});
