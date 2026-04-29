import { assetPriceToE8, fromScaledInt, priceToE6, sizeToE6 } from "@wiggler/lib/domain/decimal";
import { describe, expect, test } from "bun:test";

describe("priceToE6", () => {
  test("scales 0.523 to 523000", () => {
    expect(priceToE6("0.523")).toBe(523_000n);
  });
  test("scales whole numbers", () => {
    expect(priceToE6("1")).toBe(1_000_000n);
  });
  test("scales numeric input", () => {
    expect(priceToE6(0.5)).toBe(500_000n);
  });
  test("truncates extra decimals", () => {
    expect(priceToE6("0.5234567")).toBe(523_456n);
  });
  test("rejects non-numeric", () => {
    expect(() => priceToE6("abc")).toThrow();
  });
});

describe("sizeToE6", () => {
  test("scales 12.5 to 12500000", () => {
    expect(sizeToE6("12.5")).toBe(12_500_000n);
  });
});

describe("assetPriceToE8", () => {
  test("scales 76324.12 to 7632412000000", () => {
    expect(assetPriceToE8("76324.12")).toBe(7_632_412_000_000n);
  });
});

describe("fromScaledInt", () => {
  test("renders 523000 / 1e6", () => {
    expect(fromScaledInt(523_000n, 1_000_000)).toBe("0.523");
  });
  test("renders 1000000 / 1e6", () => {
    expect(fromScaledInt(1_000_000n, 1_000_000)).toBe("1");
  });
  test("renders 0", () => {
    expect(fromScaledInt(0n, 1_000_000)).toBe("0");
  });
  test("renders 7632412000000 / 1e8", () => {
    expect(fromScaledInt(7_632_412_000_000n, 100_000_000)).toBe("76324.12");
  });
  test("renders negative", () => {
    expect(fromScaledInt(-523_000n, 1_000_000)).toBe("-0.523");
  });
});
