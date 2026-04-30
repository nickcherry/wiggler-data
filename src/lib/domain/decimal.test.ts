import {
  assetPriceToE8,
  fromScaledInt,
  toScaledInt,
} from "@wiggler/lib/domain/decimal";
import { describe, expect, test } from "bun:test";

describe("toScaledInt", () => {
  test("scales 0.523 at 1e6", () => {
    expect(toScaledInt("0.523", 1_000_000)).toBe(523_000n);
  });
  test("scales whole numbers", () => {
    expect(toScaledInt("1", 1_000_000)).toBe(1_000_000n);
  });
  test("truncates extra decimals beyond the scale", () => {
    expect(toScaledInt("0.5234567", 1_000_000)).toBe(523_456n);
  });
  test("scales numeric input", () => {
    expect(toScaledInt(0.5, 1_000_000)).toBe(500_000n);
  });
  test("rejects non-numeric input", () => {
    expect(() => toScaledInt("abc", 1_000_000)).toThrow();
  });
});

describe("assetPriceToE8", () => {
  test("scales 76324.12 to 7632412000000", () => {
    expect(assetPriceToE8("76324.12")).toBe(7_632_412_000_000n);
  });
  test("handles BTC-style 8-decimal precision", () => {
    expect(assetPriceToE8("0.00000001")).toBe(1n);
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
