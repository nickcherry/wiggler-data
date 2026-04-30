import {
  buildWinProbGrid,
  type ClosePoint,
} from "@wiggler/lib/candles/winProbGrid";
import {
  buildWigglerProbGridConfig,
  computeGridHash,
  WIGGLER_PROB_GRID_VERSION,
} from "@wiggler/lib/candles/winProbGridConfig";
import { describe, expect, test } from "bun:test";

const E8 = 100_000_000n;

function close(tsMs: number, priceWhole: number): ClosePoint {
  return { tsMs, closeE8: BigInt(priceWhole) * E8 };
}

describe("buildWigglerProbGridConfig", () => {
  function makeGrid(): ReturnType<typeof buildWinProbGrid> {
    const closes: ClosePoint[] = Array.from({ length: 60 }, (_, m) =>
      close(m * 60_000, 1000 + m),
    );
    return buildWinProbGrid({
      closes,
      intervalSec: 300,
      volLookbackMin: 10,
    });
  }

  test("includes version, asset, and bucket definitions verbatim", () => {
    const grid = makeGrid();
    const config = buildWigglerProbGridConfig({
      grid,
      asset: "btc",
      trainingLabelSource: "vwap",
      volLookbackMin: 10,
      git: { commit_sha: "deadbeef", dirty: false },
      generatedAtIso: "2026-04-30T00:00:00.000Z",
    });
    expect(config.version).toBe(WIGGLER_PROB_GRID_VERSION);
    expect(config.asset).toBe("BTC");
    expect(config.interval_sec).toBe(300);
    expect(config.abs_d_bps_boundaries).toEqual(grid.absDBpsBoundaries);
    expect(config.remaining_sec_buckets).toEqual(grid.decisionRemainingSecs);
  });

  test("anchor_mode reflects rolling vs boundary stride", () => {
    const grid = makeGrid();
    const rolling = buildWigglerProbGridConfig({
      grid,
      asset: "BTC",
      trainingLabelSource: "vwap",
      volLookbackMin: 10,
    });
    expect(rolling.anchor_mode).toBe("rolling");

    const closes: ClosePoint[] = Array.from({ length: 60 }, (_, m) =>
      close(m * 60_000, 1000 + m),
    );
    const aligned = buildWinProbGrid({
      closes,
      intervalSec: 300,
      volLookbackMin: 10,
      anchorStepMin: 5,
    });
    const config = buildWigglerProbGridConfig({
      grid: aligned,
      asset: "BTC",
      trainingLabelSource: "vwap",
      volLookbackMin: 10,
    });
    expect(config.anchor_mode).toBe("boundary");
  });

  test("vwap label_source_note flags Chainlink basis risk", () => {
    const grid = makeGrid();
    const config = buildWigglerProbGridConfig({
      grid,
      asset: "BTC",
      trainingLabelSource: "vwap",
      volLookbackMin: 10,
    });
    expect(config.training_input.label_source).toBe("vwap");
    expect(config.training_input.label_source_note.toLowerCase()).toContain(
      "chainlink",
    );
    expect(config.resolution_source.proxy_basis_risk).toBe("unmeasured");
  });

  test("min_remaining_sec_to_trade defaults to 60", () => {
    const grid = makeGrid();
    const config = buildWigglerProbGridConfig({
      grid,
      asset: "BTC",
      trainingLabelSource: "vwap",
      volLookbackMin: 10,
    });
    expect(config.risk_defaults.min_remaining_sec_to_trade).toBe(60);
  });

  test("config_hash is deterministic and changes when bucket counts change", () => {
    const grid1 = makeGrid();
    const grid2 = makeGrid();
    expect(computeGridHash(grid1)).toBe(computeGridHash(grid2));

    // Mutate one bucket count → new hash.
    const mutated = {
      ...grid1,
      buckets: grid1.buckets.map((b, i) =>
        i === 0 ? { ...b, count: b.count + 1 } : b,
      ),
    };
    expect(computeGridHash(mutated)).not.toBe(computeGridHash(grid1));
  });

  test("training_input window matches the grid's anchor span", () => {
    const grid = makeGrid();
    const config = buildWigglerProbGridConfig({
      grid,
      asset: "BTC",
      trainingLabelSource: "vwap",
      volLookbackMin: 10,
    });
    expect(config.training_input.window_start_ms).toBe(
      grid.firstAnchorOpenTimeMs,
    );
    expect(config.training_input.window_end_ms).toBe(
      grid.lastIntervalEndOpenTimeMs,
    );
  });
});
