import {
  fromBitfinexSymbol,
  fromBitstampSymbol,
  fromBybitSymbol,
  fromGeminiSymbol,
  fromKrakenSymbol,
  toBitfinexSymbol,
  toBitstampSymbol,
  toBybitSymbol,
  toGeminiSymbol,
  toKrakenSymbol,
} from "@wiggler/lib/prices/symbols";
import { describe, expect, test } from "bun:test";

describe("symbol mappers — Gemini", () => {
  test("BTC -> BTCUSD round-trips", () => {
    expect(toGeminiSymbol("BTC")).toBe("BTCUSD");
    expect(fromGeminiSymbol("BTCUSD")).toBe("BTC");
  });
  test("lowercase input is upper-cased", () => {
    expect(toGeminiSymbol("eth")).toBe("ETHUSD");
  });
});

describe("symbol mappers — Bybit", () => {
  test("BTC -> BTCUSDT round-trips", () => {
    expect(toBybitSymbol("BTC")).toBe("BTCUSDT");
    expect(fromBybitSymbol("BTCUSDT")).toBe("BTC");
  });
  test("symbol without USDT suffix is returned upper-cased", () => {
    expect(fromBybitSymbol("foo")).toBe("FOO");
  });
});

describe("symbol mappers — Bitstamp", () => {
  test("BTC -> btcusd round-trips through canonical upper-case", () => {
    expect(toBitstampSymbol("BTC")).toBe("btcusd");
    expect(fromBitstampSymbol("btcusd")).toBe("BTC");
  });
  test("input is lowercased even if upper", () => {
    expect(toBitstampSymbol("ETH")).toBe("ethusd");
  });
});

describe("symbol mappers — Bitfinex", () => {
  test("BTC -> tBTCUSD round-trips", () => {
    expect(toBitfinexSymbol("BTC")).toBe("tBTCUSD");
    expect(fromBitfinexSymbol("tBTCUSD")).toBe("BTC");
  });
  test("does not strip the leading t when absent", () => {
    expect(fromBitfinexSymbol("BTCUSD")).toBe("BTC");
  });
});

describe("symbol mappers — Kraken", () => {
  test("BTC -> BTC/USD round-trips", () => {
    expect(toKrakenSymbol("BTC")).toBe("BTC/USD");
    expect(fromKrakenSymbol("BTC/USD")).toBe("BTC");
  });
  test("non-slash input falls back to upper-case", () => {
    expect(fromKrakenSymbol("ethusd")).toBe("ETHUSD");
  });
});
