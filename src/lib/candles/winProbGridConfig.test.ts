import { getEligibility } from "@wiggler/lib/candles/eligibility";
import {
  buildWinProbGrid,
  type ClosePoint,
} from "@wiggler/lib/candles/winProbGrid";
import {
  buildWigglerProbGridConfig,
  computeGridHash,
  computeInputHash,
  WIGGLER_PROB_GRID_VERSION,
} from "@wiggler/lib/candles/winProbGridConfig";
import { describe, expect, test } from "bun:test";

const E8 = 100_000_000n;

function close(tsMs: number, priceWhole: number): ClosePoint {
  return { tsMs, closeE8: BigInt(priceWhole) * E8 };
}

const SAMPLE_CLOSES: ClosePoint[] = Array.from({ length: 60 }, (_, m) =>
  close(m * 60_000, 1000 + m),
);
const SAMPLE_INPUT_HASH = computeInputHash(SAMPLE_CLOSES);
const BTC_ELIGIBILITY = getEligibility("BTC")!;
const HYPE_ELIGIBILITY = getEligibility("HYPE")!;

describe("buildWigglerProbGridConfig", () => {
  function makeGrid(): ReturnType<typeof buildWinProbGrid> {
    return buildWinProbGrid({
      closes: SAMPLE_CLOSES,
      intervalSec: 300,
      volLookbackMin: 10,
    });
  }

  function makeConfig(overrides: Partial<Parameters<typeof buildWigglerProbGridConfig>[0]> = {}) {
    const grid = overrides.grid ?? makeGrid();
    return buildWigglerProbGridConfig({
      grid,
      asset: "btc",
      trainingLabelSource: "vwap",
      volLookbackMin: 10,
      inputHash: SAMPLE_INPUT_HASH,
      eligibility: BTC_ELIGIBILITY,
      git: { commit_sha: "deadbeef", dirty: false },
      generatedAtIso: "2026-04-30T00:00:00.000Z",
      ...overrides,
    });
  }

  test("includes version, asset, and bucket definitions verbatim", () => {
    const config = makeConfig();
    expect(config.version).toBe(WIGGLER_PROB_GRID_VERSION);
    expect(config.asset).toBe("BTC");
    expect(config.interval_sec).toBe(300);
    expect(config.abs_d_bps_boundaries).toEqual(makeGrid().absDBpsBoundaries);
    expect(config.remaining_sec_buckets).toEqual(makeGrid().decisionRemainingSecs);
  });

  test("anchor_mode reflects rolling vs boundary stride", () => {
    const rolling = makeConfig();
    expect(rolling.anchor_mode).toBe("rolling");

    const aligned = buildWinProbGrid({
      closes: SAMPLE_CLOSES,
      intervalSec: 300,
      volLookbackMin: 10,
      anchorStepMin: 5,
    });
    const config = makeConfig({ grid: aligned });
    expect(config.anchor_mode).toBe("boundary");
  });

  test("label_source_kind is vwap_chainlink_proxy when source is vwap", () => {
    const config = makeConfig();
    expect(config.training_input.label_source).toBe("vwap");
    expect(config.training_input.label_source_kind).toBe(
      "vwap_chainlink_proxy",
    );
    expect(config.training_input.label_source_note.toLowerCase()).toContain(
      "chainlink",
    );
    expect(config.resolution_source.proxy_basis_risk).toBe("unmeasured");
  });

  test("label_source_kind is single_venue_chainlink_proxy when source is a CEX", () => {
    const config = makeConfig({ trainingLabelSource: "coinbase" });
    expect(config.training_input.label_source_kind).toBe(
      "single_venue_chainlink_proxy",
    );
  });

  test("min_remaining_sec_to_trade defaults to 60", () => {
    expect(makeConfig().risk_defaults.min_remaining_sec_to_trade).toBe(60);
  });

  test("config_hash is deterministic and changes when bucket counts change", () => {
    const grid1 = makeGrid();
    const grid2 = makeGrid();
    expect(computeGridHash(grid1)).toBe(computeGridHash(grid2));
    const mutated = {
      ...grid1,
      buckets: grid1.buckets.map((b, i) =>
        i === 0 ? { ...b, count: b.count + 1 } : b,
      ),
    };
    expect(computeGridHash(mutated)).not.toBe(computeGridHash(grid1));
  });

  test("training_input.input_hash is deterministic for the same closes and changes when closes change", () => {
    const a = computeInputHash(SAMPLE_CLOSES);
    const b = computeInputHash(SAMPLE_CLOSES);
    expect(a).toBe(b);
    const mutated = SAMPLE_CLOSES.slice(0, -1);
    expect(computeInputHash(mutated)).not.toBe(a);
  });

  test("training_input window matches the grid's anchor span", () => {
    const grid = makeGrid();
    const config = makeConfig({ grid });
    expect(config.training_input.window_start_ms).toBe(
      grid.firstAnchorOpenTimeMs,
    );
    expect(config.training_input.window_end_ms).toBe(
      grid.lastIntervalEndOpenTimeMs,
    );
  });

  test("eligibility is carried through to the emitted config", () => {
    const btc = makeConfig();
    expect(btc.eligibility.eligible_for_paper).toBe(true);
    expect(btc.eligibility.eligible_for_live).toBe(false);
    expect(btc.eligibility.quarantine).toBe(false);

    const hype = makeConfig({ asset: "hype", eligibility: HYPE_ELIGIBILITY });
    expect(hype.eligibility.quarantine).toBe(true);
    expect(hype.eligibility.eligible_for_paper).toBe(false);
    expect(hype.eligibility.quarantine_reasons.length).toBeGreaterThan(0);
  });
});
