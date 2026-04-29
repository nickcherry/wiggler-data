import { ageFrom } from "@wiggler/lib/audit/freshness";
import { describe, expect, test } from "bun:test";

describe("ageFrom", () => {
  test("returns null for missing data", () => {
    const result = ageFrom(null, 1000);
    expect(result.ageMs).toBeNull();
    expect(result.display).toBe("(no data)");
  });

  test("computes positive age", () => {
    const result = ageFrom(new Date(900), 1000);
    expect(result.ageMs).toBe(100);
  });

  test("clamps negative ages (clock skew) to zero", () => {
    const result = ageFrom(new Date(1100), 1000);
    expect(result.ageMs).toBe(0);
    expect(result.display).toBe("0ms");
  });
});
