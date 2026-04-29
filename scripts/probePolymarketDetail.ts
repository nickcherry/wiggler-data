/**
 * One-off: capture the first full frame of each event_type emitted by the
 * Polymarket market WS for the current BTC market. Prints them untruncated so
 * we can confirm the schema we expect matches reality.
 *
 * Run: `bun scripts/probePolymarketDetail.ts`
 */

import { env } from "@wiggler/constants/env";
import { getFiveMinuteWindow } from "@wiggler/lib/domain/marketWindow";
import { fetchGammaEventBySlug } from "@wiggler/lib/polymarket/gammaClient";
import { parseGammaEvent } from "@wiggler/lib/polymarket/parseEvent";
import { buildUpDownSlugFromWindow } from "@wiggler/lib/polymarket/slug";
import WebSocket from "ws";

const slug = buildUpDownSlugFromWindow("BTC", getFiveMinuteWindow());
const result = await fetchGammaEventBySlug(slug);
if (result.status !== "ok") {
  throw new Error(`gamma not ok: ${result.status}`);
}
const parsed = parseGammaEvent({
  event: result.event,
  raw: result.raw,
  assetSymbol: "BTC",
});
if (!parsed?.upTokenId || !parsed?.downTokenId) {
  throw new Error("no token ids");
}

const ws = new WebSocket(env.polymarketWsUrl);
const seenTypes = new Set<string>();

await new Promise<void>((resolve) => {
  ws.once("open", () => {
    ws.send(
      JSON.stringify({
        type: "market",
        assets_ids: [parsed.upTokenId, parsed.downTokenId],
      }),
    );
  });
  ws.on("message", (data: WebSocket.RawData) => {
    try {
      const text = rawDataToString(data);
      if (text.trim().toUpperCase() === "PONG") {
        return;
      }
      const items: unknown = JSON.parse(text);
      const arr = Array.isArray(items) ? items : [items];
      for (const item of arr) {
        const t =
          item && typeof item === "object" && "event_type" in item
            ? String((item as { event_type: unknown }).event_type)
            : "no_event_type";
        if (!seenTypes.has(t)) {
          seenTypes.add(t);
          console.log(`\n=== FIRST FRAME OF TYPE: ${t} ===`);
          console.log(JSON.stringify(item, null, 2));
        }
      }
      if (seenTypes.size >= 5) {
        ws.close();
        resolve();
      }
    } catch {
      // ignore
    }
  });
  setTimeout(() => {
    ws.close();
    resolve();
  }, 10_000);
});

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
