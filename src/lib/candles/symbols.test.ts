import {
  exchangePair,
  fromBinancePair,
  fromBitfinexPair,
  fromBitstampPair,
  fromCoinbasePair,
} from "@wiggler/lib/candles/symbols";
import { describe, expect, test } from "bun:test";

describe("exchangePair", () => {
  test("BTC → coinbase BTC-USD", () => {
    expect(exchangePair("coinbase", "BTC")).toBe("BTC-USD");
  });
  test("BTC → binance BTCUSDT", () => {
    expect(exchangePair("binance", "BTC")).toBe("BTCUSDT");
  });
  test("BTC → bitstamp btcusd (lowercase)", () => {
    expect(exchangePair("bitstamp", "BTC")).toBe("btcusd");
  });
  test("BTC → bitfinex tBTCUSD (with `t` prefix)", () => {
    expect(exchangePair("bitfinex", "BTC")).toBe("tBTCUSD");
  });
  test("normalizes case from lowercase input", () => {
    expect(exchangePair("coinbase", "btc")).toBe("BTC-USD");
    expect(exchangePair("binance", "eth")).toBe("ETHUSDT");
    expect(exchangePair("bitstamp", "ETH")).toBe("ethusd");
    expect(exchangePair("bitfinex", "eth")).toBe("tETHUSD");
  });
});

describe("inverse pair mappers", () => {
  test("coinbase round-trips", () => {
    expect(fromCoinbasePair("BTC-USD")).toBe("BTC");
  });
  test("binance round-trips", () => {
    expect(fromBinancePair("BTCUSDT")).toBe("BTC");
  });
  test("bitstamp round-trips and uppercases the symbol", () => {
    expect(fromBitstampPair("btcusd")).toBe("BTC");
  });
  test("bitfinex strips the `t` prefix", () => {
    expect(fromBitfinexPair("tBTCUSD")).toBe("BTC");
  });
});
