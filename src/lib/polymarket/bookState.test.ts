import { BookState } from "@wiggler/lib/polymarket/bookState";
import type { PriceChangeSlice } from "@wiggler/lib/polymarket/wsEvents";
import { describe, expect, test } from "bun:test";

function buyEntry(assetId: string, price: string, size: string): PriceChangeSlice["entries"][number] {
  return { asset_id: assetId, price, side: "BUY", size };
}

function sellEntry(assetId: string, price: string, size: string): PriceChangeSlice["entries"][number] {
  return { asset_id: assetId, price, side: "SELL", size };
}

describe("BookState", () => {
  test("applies a snapshot and reports best bid/ask", () => {
    const book = new BookState("asset-1");
    book.applySnapshot(
      {
        event_type: "book",
        asset_id: "asset-1",
        market: "0xmarket",
        bids: [
          { price: "0.48", size: "100" },
          { price: "0.47", size: "200" },
        ],
        asks: [
          { price: "0.51", size: "100" },
          { price: "0.52", size: "200" },
        ],
      },
      1000,
    );
    expect(book.getBestBid()?.priceE6).toBe(480_000n);
    expect(book.getBestAsk()?.priceE6).toBe(510_000n);
    expect(book.isCrossed()).toBe(false);
  });

  test("snapshot captures tick_size when present", () => {
    const book = new BookState("asset-1");
    book.applySnapshot(
      {
        event_type: "book",
        asset_id: "asset-1",
        bids: [{ price: "0.48", size: "100" }],
        asks: [{ price: "0.51", size: "100" }],
        tick_size: "0.01",
      },
      1000,
    );
    expect(book.tickSizeE6).toBe(10_000n);
  });

  test("price_change zero size removes a level", () => {
    const book = new BookState("asset-1");
    book.applySnapshot(
      {
        event_type: "book",
        asset_id: "asset-1",
        bids: [{ price: "0.48", size: "100" }],
        asks: [{ price: "0.51", size: "100" }],
      },
      1000,
    );
    book.applyPriceChange(
      { entries: [buyEntry("asset-1", "0.48", "0")] },
      2000,
    );
    expect(book.getBestBid()).toBeNull();
  });

  test("price_change updates a level size in place", () => {
    const book = new BookState("asset-1");
    book.applySnapshot(
      {
        event_type: "book",
        asset_id: "asset-1",
        bids: [{ price: "0.48", size: "100" }],
        asks: [{ price: "0.51", size: "100" }],
      },
      1000,
    );
    book.applyPriceChange(
      { entries: [buyEntry("asset-1", "0.48", "250")] },
      2000,
    );
    expect(book.getBestBid()?.sizeE6).toBe(250_000_000n);
  });

  test("price_change SELL entries update the ask side", () => {
    const book = new BookState("asset-1");
    book.applySnapshot(
      {
        event_type: "book",
        asset_id: "asset-1",
        bids: [{ price: "0.48", size: "100" }],
        asks: [{ price: "0.51", size: "100" }],
      },
      1000,
    );
    book.applyPriceChange(
      { entries: [sellEntry("asset-1", "0.50", "50")] },
      2000,
    );
    expect(book.getBestAsk()?.priceE6).toBe(500_000n);
  });

  test("getTopLevels returns sorted top N", () => {
    const book = new BookState("asset-1");
    book.applySnapshot(
      {
        event_type: "book",
        asset_id: "asset-1",
        bids: [
          { price: "0.46", size: "50" },
          { price: "0.49", size: "100" },
          { price: "0.48", size: "75" },
        ],
        asks: [
          { price: "0.55", size: "100" },
          { price: "0.52", size: "75" },
          { price: "0.53", size: "50" },
        ],
      },
      1000,
    );
    const top = book.getTopLevels(2);
    expect(top.bids[0]!.priceE6).toBe(490_000n);
    expect(top.bids[1]!.priceE6).toBe(480_000n);
    expect(top.asks[0]!.priceE6).toBe(520_000n);
    expect(top.asks[1]!.priceE6).toBe(530_000n);
  });

  test("isCrossed detects an inverted book", () => {
    const book = new BookState("asset-1");
    book.applySnapshot(
      {
        event_type: "book",
        asset_id: "asset-1",
        bids: [{ price: "0.55", size: "10" }],
        asks: [{ price: "0.50", size: "10" }],
      },
      1000,
    );
    expect(book.isCrossed()).toBe(true);
  });

  test("tick_size_change updates the tick size", () => {
    const book = new BookState("asset-1");
    book.applyTickSizeChange(
      {
        event_type: "tick_size_change",
        asset_id: "asset-1",
        new_tick_size: "0.001",
      },
      1000,
    );
    expect(book.tickSizeE6).toBe(1000n);
  });

  test("hashTopLevels produces stable strings", () => {
    const book = new BookState("asset-1");
    book.applySnapshot(
      {
        event_type: "book",
        asset_id: "asset-1",
        bids: [{ price: "0.48", size: "100" }],
        asks: [{ price: "0.51", size: "100" }],
      },
      1000,
    );
    const a = book.hashTopLevels(5);
    const b = book.hashTopLevels(5);
    expect(a).toBe(b);
  });

  test("rejects negative size", () => {
    const book = new BookState("asset-1");
    expect(() =>
      book.applyPriceChange(
        { entries: [buyEntry("asset-1", "0.48", "-1")] },
        1000,
      ),
    ).toThrow();
  });
});
