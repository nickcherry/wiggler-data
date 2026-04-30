import {
  classifyEt,
  etWeekdayShort,
  minuteOfHourUtc,
  utcHour,
} from "@wiggler/lib/candles/sessions";
import { describe, expect, test } from "bun:test";

// All anchor times below are explicit ISO timestamps; the test
// coverage targets DST and weekday boundaries specifically since
// those are where naive offset math typically breaks.

describe("classifyEt", () => {
  test("Mon 2026-01-12 09:30 ET (14:30 UTC, EST) → weekday_us_cash", () => {
    const ms = Date.parse("2026-01-12T14:30:00Z");
    const r = classifyEt(ms);
    expect(r.session).toBe("weekday_us_cash");
    expect(r.weekdayShort).toBe("Mon");
    expect(r.etHour).toBe(9);
    expect(r.etMinute).toBe(30);
  });

  test("Mon 2026-01-12 09:29 ET → weekday_us_extended (right before cash open)", () => {
    const ms = Date.parse("2026-01-12T14:29:00Z");
    const r = classifyEt(ms);
    expect(r.session).toBe("weekday_us_extended");
  });

  test("Mon 2026-01-12 16:00 ET → weekday_us_extended (cash close = extended start)", () => {
    const ms = Date.parse("2026-01-12T21:00:00Z");
    const r = classifyEt(ms);
    expect(r.session).toBe("weekday_us_extended");
  });

  test("Mon 2026-01-12 20:00 ET → weekday_overnight (extended close = overnight start)", () => {
    const ms = Date.parse("2026-01-13T01:00:00Z");
    const r = classifyEt(ms);
    expect(r.session).toBe("weekday_overnight");
  });

  test("Mon 2026-01-12 07:59 ET → weekday_overnight (right before extended open)", () => {
    const ms = Date.parse("2026-01-12T12:59:00Z");
    const r = classifyEt(ms);
    expect(r.session).toBe("weekday_overnight");
  });

  test("Sat 2026-01-10 noon ET → weekend", () => {
    const ms = Date.parse("2026-01-10T17:00:00Z");
    const r = classifyEt(ms);
    expect(r.session).toBe("weekend");
    expect(r.weekdayShort).toBe("Sat");
  });

  test("Sun 2026-01-11 → weekend", () => {
    const ms = Date.parse("2026-01-11T15:00:00Z");
    const r = classifyEt(ms);
    expect(r.session).toBe("weekend");
  });

  test("DST spring-forward: 2026-03-09 09:30 ET (= 13:30 UTC, EDT) → cash", () => {
    // After DST starts on second Sunday of March, NY = UTC-4. So 09:30
    // ET is 13:30 UTC, not 14:30. This test fails fast if we hard-code
    // the EST offset.
    const ms = Date.parse("2026-03-09T13:30:00Z");
    const r = classifyEt(ms);
    expect(r.session).toBe("weekday_us_cash");
    expect(r.etHour).toBe(9);
    expect(r.etMinute).toBe(30);
  });
});

describe("etWeekdayShort", () => {
  test("matches classifyEt", () => {
    const ms = Date.parse("2026-04-30T20:00:00Z");
    expect(etWeekdayShort(ms)).toBe(classifyEt(ms).weekdayShort);
  });
});

describe("utcHour", () => {
  test("returns the UTC hour", () => {
    expect(utcHour(Date.parse("2026-01-12T14:30:00Z"))).toBe(14);
    expect(utcHour(Date.parse("2026-01-12T00:00:00Z"))).toBe(0);
    expect(utcHour(Date.parse("2026-01-12T23:59:59Z"))).toBe(23);
  });
});

describe("minuteOfHourUtc", () => {
  test("0..59", () => {
    expect(minuteOfHourUtc(Date.parse("2026-01-12T14:00:00Z"))).toBe(0);
    expect(minuteOfHourUtc(Date.parse("2026-01-12T14:05:00Z"))).toBe(5);
    expect(minuteOfHourUtc(Date.parse("2026-01-12T14:35:00Z"))).toBe(35);
    expect(minuteOfHourUtc(Date.parse("2026-01-12T14:59:00Z"))).toBe(59);
  });
});
