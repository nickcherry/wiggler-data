/**
 * Live probe for every external feed wiggler talks to. Connects to:
 *
 *   - Polymarket Gamma (HTTP, current BTC slug)
 *   - Polymarket market WebSocket
 *   - Coinbase ticker WebSocket
 *   - Binance bookTicker WebSocket
 *
 * For each, captures a few frames, validates them against the application's
 * Zod schemas / parsers, and prints a compact report.
 *
 * Run: `bun scripts/probeFeeds.ts`
 *
 * Read-only. Does not write to the database.
 */

import { env } from "@wiggler/constants/env";
import { getFiveMinuteWindow } from "@wiggler/lib/domain/marketWindow";
import { fetchGammaEventBySlug } from "@wiggler/lib/polymarket/gammaClient";
import { parseGammaEvent } from "@wiggler/lib/polymarket/parseEvent";
import { buildUpDownSlugFromWindow } from "@wiggler/lib/polymarket/slug";
import { tryParseWsEvent } from "@wiggler/lib/polymarket/wsEvents";
import {
  toBinanceSymbol,
  toCoinbaseProductId,
} from "@wiggler/lib/prices/symbols";
import WebSocket from "ws";

const PROBE_DURATION_MS = 6_000;

async function main(): Promise<void> {
  const asset = env.defaultAsset;
  console.log(`probing live feeds for asset=${asset}\n`);

  await probeGamma(asset);
  console.log();
  const slug = await probePolymarketWs(asset);
  console.log();
  await probeCoinbaseWs(asset);
  console.log();
  await probeBinanceWs(asset);

  console.log("\nprobe complete");
  void slug;
}

async function probeGamma(asset: string): Promise<void> {
  console.log("== Polymarket Gamma ==");
  const window = getFiveMinuteWindow();
  const slug = buildUpDownSlugFromWindow(asset, window);
  console.log(`  slug: ${slug}`);
  const result = await fetchGammaEventBySlug(slug);
  console.log(`  status: ${result.status}`);
  if (result.status !== "ok") {
    if (result.status === "error") {
      console.log(`  error: ${result.httpStatus} ${result.body.slice(0, 200)}`);
    }
    return;
  }
  const parsed = parseGammaEvent({
    event: result.event,
    raw: result.raw,
    assetSymbol: asset,
  });
  if (!parsed) {
    console.log("  parse: FAILED");
    return;
  }
  console.log("  parse: ok");
  console.log(
    `    window: ${new Date(parsed.startMs).toISOString()} -> ${new Date(parsed.endMs).toISOString()}`,
  );
  console.log(`    condition_id: ${parsed.conditionId ?? "(none)"}`);
  console.log(`    up_token_id: ${truncate(parsed.upTokenId, 32)}`);
  console.log(`    down_token_id: ${truncate(parsed.downTokenId, 32)}`);
  console.log(`    resolution_source: ${parsed.resolutionSource ?? "(none)"}`);
}

async function probePolymarketWs(asset: string): Promise<string | null> {
  console.log("== Polymarket WS ==");
  const window = getFiveMinuteWindow();
  const slug = buildUpDownSlugFromWindow(asset, window);
  const result = await fetchGammaEventBySlug(slug);
  if (result.status !== "ok") {
    console.log("  skipping: gamma did not return ok");
    return null;
  }
  const parsed = parseGammaEvent({
    event: result.event,
    raw: result.raw,
    assetSymbol: asset,
  });
  if (!parsed?.upTokenId || !parsed?.downTokenId) {
    console.log("  skipping: missing token ids");
    return null;
  }
  const assetIds = [parsed.upTokenId, parsed.downTokenId];
  const counts = new Map<string, number>();
  const samples = new Map<string, unknown>();
  let parseFailures = 0;
  let totalFrames = 0;

  await runWsProbe({
    url: env.polymarketWsUrl,
    onOpen: (ws) => {
      ws.send(JSON.stringify({ type: "market", assets_ids: assetIds }));
    },
    onMessage: (frame) => {
      totalFrames += 1;
      const items = Array.isArray(frame) ? frame : [frame];
      for (const item of items) {
        const typed = tryParseWsEvent(item);
        const eventType =
          typed?.event_type ??
          (item && typeof item === "object" && "event_type" in item
            ? String((item as { event_type: unknown }).event_type)
            : "(unknown)");
        counts.set(eventType, (counts.get(eventType) ?? 0) + 1);
        if (!samples.has(eventType)) {
          samples.set(eventType, item);
        }
        if (typed === null && eventType !== "(unknown)") {
          parseFailures += 1;
        }
      }
    },
  });

  console.log(`  total_raw_frames: ${totalFrames}`);
  console.log(`  events_by_type:`);
  for (const [type, count] of [...counts.entries()].sort()) {
    console.log(`    ${type}: ${count}`);
  }
  console.log(`  parse_failures: ${parseFailures}`);
  if (totalFrames === 0) {
    console.log("  (no frames received — book may have no activity right now)");
  }
  for (const [type, sample] of samples) {
    console.log(`  sample [${type}]: ${truncate(JSON.stringify(sample), 240)}`);
  }
  return slug;
}

async function probeCoinbaseWs(asset: string): Promise<void> {
  console.log("== Coinbase WS ==");
  const productId = toCoinbaseProductId(asset);
  let frames = 0;
  const counts = new Map<string, number>();
  const samples = new Map<string, unknown>();

  await runWsProbe({
    url: env.coinbaseWsUrl,
    onOpen: (ws) => {
      ws.send(
        JSON.stringify({
          type: "subscribe",
          product_ids: [productId],
          channels: ["ticker"],
        }),
      );
    },
    onMessage: (frame) => {
      frames += 1;
      if (frame && typeof frame === "object" && "type" in frame) {
        const t = String(frame.type);
        counts.set(t, (counts.get(t) ?? 0) + 1);
        if (!samples.has(t)) {
          samples.set(t, frame);
        }
      }
    },
  });

  console.log(`  total_frames: ${frames}`);
  console.log(`  by_type:`);
  for (const [type, count] of [...counts.entries()].sort()) {
    console.log(`    ${type}: ${count}`);
  }
  for (const [type, sample] of samples) {
    if (type === "ticker" || type === "subscriptions" || type === "error") {
      console.log(`  sample [${type}]: ${truncate(JSON.stringify(sample), 240)}`);
    }
  }
}

async function probeBinanceWs(asset: string): Promise<void> {
  console.log("== Binance WS ==");
  const symbol = toBinanceSymbol(asset).toLowerCase();
  const url = `${env.binanceWsUrl.replace(/\/$/, "")}/stream?streams=${symbol}@bookTicker`;
  let frames = 0;
  let combinedFrames = 0;
  let bareFrames = 0;
  let firstSample: unknown = null;

  await runWsProbe({
    url,
    onMessage: (frame) => {
      frames += 1;
      if (frame && typeof frame === "object") {
        if ("data" in frame && "stream" in frame) {
          combinedFrames += 1;
        } else if ("s" in frame && "b" in frame && "a" in frame) {
          bareFrames += 1;
        }
      }
      if (firstSample === null) {
        firstSample = frame;
      }
    },
  });

  console.log(`  total_frames: ${frames}`);
  console.log(`  combined_envelope: ${combinedFrames}`);
  console.log(`  bare_book_ticker: ${bareFrames}`);
  if (firstSample !== null) {
    console.log(`  sample: ${truncate(JSON.stringify(firstSample), 240)}`);
  }
}

async function runWsProbe(args: {
  url: string;
  onOpen?: (ws: WebSocket) => void;
  onMessage: (parsed: unknown) => void;
  durationMs?: number;
}): Promise<void> {
  const ws = new WebSocket(args.url);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
  });
  args.onOpen?.(ws);
  const deadline = Date.now() + (args.durationMs ?? PROBE_DURATION_MS);
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (Date.now() >= deadline) {
        clearInterval(timer);
        ws.close();
        resolve();
      }
    }, 250);
    ws.on("message", (data: WebSocket.RawData) => {
      const text = rawDataToString(data).trim();
      if (text.length === 0 || text.toUpperCase() === "PONG") {
        return;
      }
      try {
        args.onMessage(JSON.parse(text));
      } catch {
        // ignore non-JSON frames
      }
    });
    ws.on("close", () => {
      clearInterval(timer);
      resolve();
    });
  });
}

function rawDataToString(data: WebSocket.RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function truncate(value: string | null, max: number): string {
  if (value === null) {
    return "(null)";
  }
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

await main();
