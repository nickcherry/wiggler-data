import { parseGammaEvent } from "@wiggler/lib/polymarket/parseEvent";
import { describe, expect, test } from "bun:test";

describe("parseGammaEvent", () => {
  test("derives window start from the slug suffix, not event.startDate", () => {
    // 1777482900s = 2026-04-29T17:15:00Z. event.startDate is the creation
    // timestamp from the previous day; we should ignore it.
    const slug = "btc-updown-5m-1777482900";
    const event = {
      id: "1",
      slug,
      startDate: "2026-04-28T17:32:35.042384Z",
      endDate: "2026-04-29T17:20:00Z",
      title: "BTC Up/Down",
      markets: [
        {
          id: "2",
          slug,
          conditionId: "0xabc",
          outcomes: '["Up","Down"]',
          clobTokenIds: '["111","222"]',
        },
      ],
    };
    const parsed = parseGammaEvent({ event, raw: event, assetSymbol: "BTC" });
    expect(parsed).not.toBeNull();
    expect(parsed!.startMs).toBe(Date.UTC(2026, 3, 29, 17, 15, 0, 0));
    expect(parsed!.endMs).toBe(Date.UTC(2026, 3, 29, 17, 20, 0, 0));
  });

  test("falls back to event.startDate / event.endDate for non-Up/Down slugs", () => {
    const slug = "some-other-market";
    const event = {
      id: "1",
      slug,
      startDate: "2026-04-29T17:00:00Z",
      endDate: "2026-04-29T18:00:00Z",
      markets: [
        {
          id: "2",
          slug,
          outcomes: '["Yes","No"]',
          clobTokenIds: '["111","222"]',
        },
      ],
    };
    const parsed = parseGammaEvent({ event, raw: event, assetSymbol: "BTC" });
    expect(parsed).not.toBeNull();
    expect(parsed!.startMs).toBe(Date.UTC(2026, 3, 29, 17, 0, 0, 0));
    expect(parsed!.endMs).toBe(Date.UTC(2026, 3, 29, 18, 0, 0, 0));
  });

  test("extracts up/down token ids from clobTokenIds + outcomes", () => {
    const slug = "btc-updown-5m-1777482900";
    const event = {
      id: "1",
      slug,
      markets: [
        {
          id: "2",
          slug,
          conditionId: "0xabc",
          outcomes: '["Up","Down"]',
          clobTokenIds: '["111","222"]',
        },
      ],
    };
    const parsed = parseGammaEvent({ event, raw: event, assetSymbol: "BTC" });
    expect(parsed!.upTokenId).toBe("111");
    expect(parsed!.downTokenId).toBe("222");
  });

  test("returns null when slug is missing", () => {
    const parsed = parseGammaEvent({
      event: { id: "1", markets: [] },
      raw: {},
      assetSymbol: "BTC",
    });
    expect(parsed).toBeNull();
  });

  test("treats closed market with outcomePrices as resolved (Down won)", () => {
    // Real-world Gamma payload: closed=true, resolved=false, outcomePrices show
    // Down (second outcome) won. We must derive resolution from closed +
    // outcomePrices, not from the unreliable top-level resolved flag.
    const slug = "btc-updown-5m-1777494000";
    const event = {
      id: "1",
      slug,
      markets: [
        {
          id: "2",
          slug,
          closed: true,
          resolved: false,
          outcomes: '["Up","Down"]',
          outcomePrices: '["0","1"]',
          clobTokenIds: '["111","222"]',
        },
      ],
    };
    const parsed = parseGammaEvent({ event, raw: event, assetSymbol: "BTC" });
    expect(parsed!.resolved).toBe(true);
    expect(parsed!.resolvedOutcome).toBe("Down");
  });

  test("treats closed market with outcomePrices as resolved (Up won)", () => {
    const slug = "btc-updown-5m-1777494000";
    const event = {
      id: "1",
      slug,
      markets: [
        {
          id: "2",
          slug,
          closed: true,
          outcomes: '["Up","Down"]',
          outcomePrices: '["1","0"]',
          clobTokenIds: '["111","222"]',
        },
      ],
    };
    const parsed = parseGammaEvent({ event, raw: event, assetSymbol: "BTC" });
    expect(parsed!.resolved).toBe(true);
    expect(parsed!.resolvedOutcome).toBe("Up");
  });

  test("does not mark in-progress (open) market as resolved even with outcomePrices", () => {
    const slug = "btc-updown-5m-1777494000";
    const event = {
      id: "1",
      slug,
      markets: [
        {
          id: "2",
          slug,
          closed: false,
          // Outcome prices on an open market reflect current implied probabilities, not resolution.
          outcomes: '["Up","Down"]',
          outcomePrices: '["0.97","0.03"]',
          clobTokenIds: '["111","222"]',
        },
      ],
    };
    const parsed = parseGammaEvent({ event, raw: event, assetSymbol: "BTC" });
    expect(parsed!.resolved).toBe(false);
    expect(parsed!.resolvedOutcome).toBeNull();
  });
});
