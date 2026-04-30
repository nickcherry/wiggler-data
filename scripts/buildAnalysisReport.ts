#!/usr/bin/env bun
/**
 * One-off: assemble a markdown analysis report across every asset
 * with vwap data. Runs win-prob-grid in both rolling + boundary
 * modes, plus calibration-report and opportunity-report in both
 * modes, and reads the cached JSON config for each to render the
 * full grid as a markdown table.
 *
 * Output: tmp/analysis/wiggler-data-analysis.md
 */

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ASSETS = ["BTC", "ETH", "SOL", "XRP", "HYPE", "DOGE", "BNB"] as const;
const MODES: ReadonlyArray<{ flag: string; mode: "rolling" | "boundary" }> = [
  { flag: "1", mode: "rolling" },
  { flag: "5", mode: "boundary" },
];

const OUT_PATH = resolve("tmp/analysis/wiggler-data-analysis.md");
mkdirSync(resolve("tmp/analysis"), { recursive: true });

function run(args: string): string {
  return execSync(`bun wiggler ${args}`, {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  })
    .toString()
    .trim();
}

function strip$(text: string): string {
  // CLI prints `$ bun run src/bin/index.ts ...` as the first line; drop it.
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
  "Source code: https://github.com/anthropics/... (private). All numbers below come from a live local Postgres after `candles:sync` → `candles:vwap` → `candles:win-prob-grid` ran against ~365 days of 1-minute candles per asset (cross-source aggregate from Coinbase, Binance.US, Bitstamp).",
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
  for (const { flag, mode } of MODES) {
    const argsCommon = `--symbol ${asset} --label-source vwap --anchor-step-min ${flag}`;
    const summary = strip$(run(`candles:win-prob-grid ${argsCommon}`));
    out.push(`### ${asset} — win-prob-grid (${mode})`);
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
    out.push(`### ${asset} — calibration-report (${mode})`);
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
    const config = JSON.parse(readFileSync(cachePath, "utf8")).config as {
      grid: Array<{
        remaining_sec: number;
        vol_bin: string;
        abs_d_bps_min: number;
        abs_d_bps_max: number | null;
        count: number;
        wins: number;
        p_win: number;
        p_win_lower: number;
      }>;
    };
    out.push(`### ${asset} — full grid (${mode}) — populated cells only`);
    out.push("");
    out.push(
      "| remaining_sec | vol_bin | abs_d_bps | count | wins | p_win | p_win_lower |",
    );
    out.push("|---:|:---|:---|---:|---:|---:|---:|");
    const populated = config.grid.filter((g) => g.count > 0);
    for (const cell of populated) {
      const range =
        cell.abs_d_bps_max === null
          ? `≥${cell.abs_d_bps_min}`
          : `[${cell.abs_d_bps_min}, ${cell.abs_d_bps_max})`;
      out.push(
        `| ${cell.remaining_sec}s | ${cell.vol_bin} | ${range} | ${cell.count.toLocaleString("en-US")} | ${cell.wins.toLocaleString("en-US")} | ${cell.p_win.toFixed(4)} | ${cell.p_win_lower.toFixed(4)} |`,
      );
    }
    out.push("");
  }
}

writeFileSync(OUT_PATH, out.join("\n") + "\n");
console.log(`wrote ${OUT_PATH}`);
console.log(`size: ${(readFileSync(OUT_PATH).byteLength / 1024).toFixed(1)} KB`);
