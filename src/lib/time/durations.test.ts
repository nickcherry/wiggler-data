import { formatDurationMs, parseDurationMs } from "@wiggler/lib/time/durations";
import { describe, expect, test } from "bun:test";

describe("parseDurationMs", () => {
  test("parses milliseconds", () => {
    expect(parseDurationMs("500ms")).toBe(500);
  });
  test("parses seconds", () => {
    expect(parseDurationMs("30s")).toBe(30_000);
  });
  test("parses minutes", () => {
    expect(parseDurationMs("5m")).toBe(300_000);
  });
  test("parses hours", () => {
    expect(parseDurationMs("24h")).toBe(86_400_000);
  });
  test("parses days", () => {
    expect(parseDurationMs("2d")).toBe(172_800_000);
  });
  test("rejects unrecognized format", () => {
    expect(() => parseDurationMs("forever")).toThrow();
  });
});

describe("formatDurationMs", () => {
  test("formats ms", () => {
    expect(formatDurationMs(348)).toBe("348ms");
  });
  test("formats seconds", () => {
    expect(formatDurationMs(1100)).toBe("1.1s");
  });
  test("formats minutes", () => {
    expect(formatDurationMs(125_000)).toBe("2.1m");
  });
  test("formats hours", () => {
    expect(formatDurationMs(7_200_000)).toBe("2.0h");
  });
});
