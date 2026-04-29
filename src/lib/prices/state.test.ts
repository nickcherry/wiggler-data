import { blendPrices, CexPriceRegistry } from "@wiggler/lib/prices/state";
import { describe, expect, test } from "bun:test";

describe("blendPrices", () => {
  test("returns null when every source is missing", () => {
    expect(blendPrices([null, null])).toEqual({ blendedMidE8: null, sourceCount: 0 });
  });
  test("returns the only source when one is present", () => {
    expect(blendPrices([100n, null])).toEqual({ blendedMidE8: 100n, sourceCount: 1 });
  });
  test("averages two sources", () => {
    expect(blendPrices([100n, 200n])).toEqual({ blendedMidE8: 150n, sourceCount: 2 });
  });
  test("integer-divides odd sums (loses < 1 unit precision)", () => {
    expect(blendPrices([100n, 101n])).toEqual({ blendedMidE8: 100n, sourceCount: 2 });
  });
  test("blends seven sources, ignoring missing ones", () => {
    expect(
      blendPrices([100n, 110n, null, 90n, null, 105n, null]),
    ).toEqual({ blendedMidE8: (100n + 110n + 90n + 105n) / 4n, sourceCount: 4 });
  });
});

describe("CexPriceRegistry", () => {
  test("get returns undefined before any record", () => {
    const reg = new CexPriceRegistry();
    expect(reg.get("coinbase", "BTC")).toBeUndefined();
  });

  test("record + get round-trips per (source, symbol)", () => {
    const reg = new CexPriceRegistry();
    reg.record({
      source: "coinbase",
      symbol: "BTC",
      exchangePair: "BTC-USD",
      receivedAtMs: 100,
      eventMs: null,
      priceE8: 12345n,
      bidE8: 12300n,
      askE8: 12400n,
      bidSizeE8: null,
      askSizeE8: null,
      sequence: null,
      raw: null,
    });
    const state = reg.get("coinbase", "BTC");
    expect(state?.priceE8).toBe(12345n);
    expect(state?.receivedAtMs).toBe(100);
    // distinct (source, symbol) keys do not interfere with each other
    expect(reg.get("binance", "BTC")).toBeUndefined();
  });

  test("isolates state per source for each of the seven CEX sources", () => {
    const reg = new CexPriceRegistry();
    const sources = [
      "coinbase",
      "binance",
      "gemini",
      "bybit",
      "bitstamp",
      "bitfinex",
      "kraken",
    ] as const;
    sources.forEach((source, i) => {
      reg.record({
        source,
        symbol: "BTC",
        exchangePair: source,
        receivedAtMs: 100 + i,
        eventMs: null,
        priceE8: BigInt(1000 + i),
        bidE8: null,
        askE8: null,
        bidSizeE8: null,
        askSizeE8: null,
        sequence: null,
        raw: null,
      });
    });
    sources.forEach((source, i) => {
      expect(reg.get(source, "BTC")?.priceE8).toBe(BigInt(1000 + i));
    });
  });

  test("record overwrites prior state for the same key", () => {
    const reg = new CexPriceRegistry();
    const base = {
      source: "coinbase" as const,
      symbol: "BTC",
      exchangePair: "BTC-USD",
      eventMs: null,
      bidE8: null,
      askE8: null,
      bidSizeE8: null,
      askSizeE8: null,
      sequence: null,
      raw: null,
    };
    reg.record({ ...base, receivedAtMs: 100, priceE8: 100n });
    reg.record({ ...base, receivedAtMs: 200, priceE8: 200n });
    expect(reg.get("coinbase", "BTC")?.priceE8).toBe(200n);
    expect(reg.get("coinbase", "BTC")?.receivedAtMs).toBe(200);
  });
});
