#!/usr/bin/env bun
/**
 * One-off: assemble a markdown analysis report across every asset
 * with vwap data. Includes:
 *
 *   - candles:training-diagnostics  (ties, anchor balance, sources)
 *   - candles:win-prob-grid          (rolling + boundary, full window)
 *   - candles:calibration-report     (in-sample, both modes)
 *   - candles:win-prob-grid          (rolling, train-prefix only)
 *   - candles:calibration-report     (OUT-OF-SAMPLE on the held-out
 *                                     suffix — the real test)
 *   - candles:opportunity-report     (rolling + boundary, with
 *                                     interval-level counts)
 *
 * For each asset it dumps the formatted CLI output plus the populated
 * cells of each grid as a markdown table.
 *
 * Output: tmp/analysis/wiggler-data-analysis.md
 */

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ASSETS = ["BTC", "ETH", "SOL", "XRP", "HYPE", "DOGE", "BNB"] as const;
const MODES: ReadonlyArray<{ flag: number; mode: "rolling" | "boundary" }> = [
  { flag: 1, mode: "rolling" },
  { flag: 5, mode: "boundary" },
];

// Train on first 9 months, hold out last 3 for out-of-sample
// calibration. The data spans roughly 2025-04-30 → 2026-04-30 so
// 2026-01-30 cuts at ~9 months.
const TRAIN_END_ISO = "2026-01-30T00:00:00Z";
const TEST_START_ISO = TRAIN_END_ISO;

const OUT_PATH = resolve("tmp/analysis/wiggler-data-analysis.md");
mkdirSync(resolve("tmp/analysis"), { recursive: true });

function run(args: string): string {
  return execSync(`bun wiggler ${args}`, {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString()
    .trim();
}

function strip$(text: string): string {
  return text.replace(/^\$ bun run [^\n]*\n?/, "");
}

const out: string[] = [];
const generatedAt = new Date().toISOString();
const gitSha = execSync("git rev-parse HEAD").toString().trim();
const gitDirty =
  execSync("git status --porcelain").toString().trim().length > 0;

out.push(`# wiggler-data analysis report`);
out.push("");
out.push(`Generated: ${generatedAt}`);
out.push(`Git: ${gitSha}${gitDirty ? " (dirty worktree)" : ""}`);
out.push("");
out.push(
  "Source: live local Postgres after `candles:sync` → `candles:vwap` ran against ~365 days of 1-minute candles per asset (cross-source aggregate from Coinbase, Binance.US, Bitstamp).",
);
out.push("");
out.push(
  `**Quarantine status (v1):** trade-eligible after diagnostics: BTC, ETH, SOL, XRP, DOGE. Quarantined until diagnostics explain: HYPE, BNB.`,
);
out.push("");
out.push(
  `**Out-of-sample window:** trained on anchors with \`open_time ≤ ${TRAIN_END_ISO}\` (~9 months); validated on the last ~3 months.`,
);
out.push("");
out.push(`## Inventory`);
out.push("");
out.push("```");
out.push(strip$(run("candles:status")));
out.push("```");
out.push("");

for (const asset of ASSETS) {
  out.push(`## ${asset}`);
  out.push("");

  // Diagnostics first — this is what reveals contamination.
  const diagnostics = strip$(
    run(`candles:training-diagnostics --symbol ${asset}`),
  );
  out.push(`### ${asset} — training diagnostics`);
  out.push("");
  out.push("```");
  out.push(diagnostics);
  out.push("```");
  out.push("");

  for (const { flag, mode } of MODES) {
    const argsCommon = `--symbol ${asset} --label-source vwap --anchor-step-min ${flag}`;
    const summary = strip$(run(`candles:win-prob-grid ${argsCommon}`));
    out.push(`### ${asset} — win-prob-grid (${mode}, full window)`);
    out.push("");
    out.push("```");
    out.push(summary);
    out.push("```");
    out.push("");

    const calibration = strip$(
      run(
        `candles:calibration-report --symbol ${asset} --label-source vwap --anchor-mode ${mode}`,
      ),
    );
    out.push(
      `### ${asset} — calibration-report (${mode}, in-sample)`,
    );
    out.push("");
    out.push("```");
    out.push(calibration);
    out.push("```");
    out.push("");

    const opportunity = strip$(
      run(
        `candles:opportunity-report --symbol ${asset} --label-source vwap --anchor-mode ${mode}`,
      ),
    );
    out.push(`### ${asset} — opportunity-report (${mode})`);
    out.push("");
    out.push("```");
    out.push(opportunity);
    out.push("```");
    out.push("");

    const cachePath = `tmp/win-prob-grid/${asset}_1m_300s_vwap_${mode}.json`;
    appendGridTable({
      out,
      heading: `${asset} — full grid (${mode}) — populated cells only`,
      cachePath,
    });
  }

  // Out-of-sample pass: only rolling for brevity. Boundary mode would
  // be even sparser in 3 months.
  const oosArgs = `--symbol ${asset} --label-source vwap --anchor-step-min 1 --train-end-iso ${TRAIN_END_ISO}`;
  const oosTrain = strip$(run(`candles:win-prob-grid ${oosArgs}`));
  out.push(`### ${asset} — win-prob-grid (rolling, TRAIN ≤ ${TRAIN_END_ISO})`);
  out.push("");
  out.push("```");
  out.push(oosTrain);
  out.push("```");
  out.push("");

  const oosCalib = strip$(
    run(
      `candles:calibration-report --symbol ${asset} --label-source vwap --anchor-mode rolling --train-end-iso ${TRAIN_END_ISO} --test-start-iso ${TEST_START_ISO}`,
    ),
  );
  out.push(
    `### ${asset} — calibration-report (rolling, OUT-OF-SAMPLE on last ~3 months)`,
  );
  out.push("");
  out.push("```");
  out.push(oosCalib);
  out.push("```");
  out.push("");
}

writeFileSync(OUT_PATH, out.join("\n") + "\n");
console.log(`wrote ${OUT_PATH}`);
console.log(`size: ${(readFileSync(OUT_PATH).byteLength / 1024).toFixed(1)} KB`);

function appendGridTable(args: {
  out: string[];
  heading: string;
  cachePath: string;
}): void {
  const config = JSON.parse(readFileSync(args.cachePath, "utf8")).config as {
    grid: Array<{
      remaining_sec: number;
      vol_bin: string;
      side_leading: string;
      abs_d_bps_min: number;
      abs_d_bps_max: number | null;
      count: number;
      wins: number;
      p_win: number;
      p_win_lower: number;
      tradable: boolean;
    }>;
  };
  args.out.push(`### ${args.heading}`);
  args.out.push("");
  args.out.push(
    "| remaining_sec | vol_bin | side_leading | abs_d_bps | count | wins | p_win | p_win_lower | tradable |",
  );
  args.out.push("|---:|:---|:---|:---|---:|---:|---:|---:|:---:|");
  const populated = config.grid.filter((g) => g.count > 0);
  for (const cell of populated) {
    const range =
      cell.abs_d_bps_max === null
        ? `≥${cell.abs_d_bps_min}`
        : `[${cell.abs_d_bps_min}, ${cell.abs_d_bps_max})`;
    args.out.push(
      `| ${cell.remaining_sec}s | ${cell.vol_bin} | ${cell.side_leading} | ${range} | ${cell.count.toLocaleString("en-US")} | ${cell.wins.toLocaleString("en-US")} | ${cell.p_win.toFixed(4)} | ${cell.p_win_lower.toFixed(4)} | ${cell.tradable ? "✓" : ""} |`,
    );
  }
  args.out.push("");
}
