import {
  buildUpDownSlug,
  buildUpDownSlugFromWindow,
  getUpDownSlugPrefix,
  isUpDownSlug,
  parseUpDownSlugStartSeconds,
} from "@wiggler/lib/polymarket/slug";
import { describe, expect, test } from "bun:test";

describe("getUpDownSlugPrefix", () => {
  test("formats BTC prefix", () => {
    expect(getUpDownSlugPrefix("BTC")).toBe("btc-updown-5m");
  });
  test("formats ETH prefix", () => {
    expect(getUpDownSlugPrefix("ETH")).toBe("eth-updown-5m");
  });
});

describe("buildUpDownSlug", () => {
  test("formats canonical BTC slug", () => {
    expect(buildUpDownSlug("BTC", 1777475700)).toBe("btc-updown-5m-1777475700");
  });
  test("formats canonical ETH slug", () => {
    expect(buildUpDownSlug("ETH", 1777475700)).toBe("eth-updown-5m-1777475700");
  });
  test("rejects non-integer", () => {
    expect(() => buildUpDownSlug("BTC", 1.5)).toThrow();
  });
  test("rejects negative", () => {
    expect(() => buildUpDownSlug("BTC", -1)).toThrow();
  });
});

describe("buildUpDownSlugFromWindow", () => {
  test("uses startMs / 1000", () => {
    const window = {
      startMs: 1777475700_000,
      endMs: 1777475700_000 + 5 * 60 * 1000,
    };
    expect(buildUpDownSlugFromWindow("BTC", window)).toBe(
      "btc-updown-5m-1777475700",
    );
  });
  test("rejects misaligned windows", () => {
    const window = { startMs: 1, endMs: 2 };
    expect(() => buildUpDownSlugFromWindow("BTC", window)).toThrow();
  });
});

describe("isUpDownSlug", () => {
  test("recognizes BTC prefix for BTC", () => {
    expect(isUpDownSlug("BTC", "btc-updown-5m-1777475700")).toBe(true);
  });
  test("rejects ETH slug for BTC asset", () => {
    expect(isUpDownSlug("BTC", "eth-updown-5m-1777475700")).toBe(false);
  });
  test("recognizes ETH prefix for ETH", () => {
    expect(isUpDownSlug("ETH", "eth-updown-5m-1777475700")).toBe(true);
  });
});

describe("parseUpDownSlugStartSeconds", () => {
  test("extracts integer suffix", () => {
    expect(parseUpDownSlugStartSeconds("BTC", "btc-updown-5m-1777475700")).toBe(
      1777475700,
    );
  });
  test("returns null for unparseable", () => {
    expect(parseUpDownSlugStartSeconds("BTC", "btc-updown-5m-abc")).toBeNull();
  });
  test("returns null for unrelated", () => {
    expect(parseUpDownSlugStartSeconds("BTC", "foo-bar-1")).toBeNull();
  });
});
