import { logger } from "@wiggler/lib/logging/logger";
import {
  fromKrakenSymbol,
  toKrakenSymbol,
} from "@wiggler/lib/prices/symbols";
import { TopOfBookTracker } from "@wiggler/lib/prices/topOfBookTracker";
import type { PriceTick } from "@wiggler/lib/prices/types";
import { parseE8, rawDataToString } from "@wiggler/lib/prices/wsHelpers";
import { sleep } from "@wiggler/lib/util/sleep";
import WebSocket from "ws";
import { z } from "zod";

const numericValue = z.union([z.number(), z.string()]);

const levelSchema = z.object({
  price: numericValue,
  qty: numericValue,
});

const bookFrameSchema = z.object({
  channel: z.literal("book"),
  type: z.enum(["snapshot", "update"]),
  data: z.array(
    z.object({
      symbol: z.string(),
      bids: z.array(levelSchema),
      asks: z.array(levelSchema),
      timestamp: z.string().optional(),
      checksum: z.number().optional(),
    }),
  ),
});

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export type KrakenClientOptions = Readonly<{
  url: string;
  symbols: readonly string[];
  signal: AbortSignal;
  onTick: (tick: PriceTick) => void;
  onError?: (error: Error) => void;
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
}>;

/**
 * Subscribes to Kraken v2's `book` channel (depth=10) for one or more
 * symbols and projects each frame to a normalized `PriceTick` with the
 * current top of book.
 *
 * Kraken sends one `snapshot` frame per symbol then `update` frames whose
 * `bids` and `asks` arrays may contain new levels (qty > 0) or removals
 * (qty == 0). We keep a `TopOfBookTracker` per symbol to compute the
 * highest bid and lowest ask after each update.
 */
export class KrakenBookClient {
  #ws: WebSocket | null = null;
  #stopped = false;
  #reconnectDelayMs = RECONNECT_INITIAL_MS;
  #lastTickAtMs: number | null = null;
  #status: "idle" | "connecting" | "connected" | "reconnecting" | "stopped" = "idle";
  /** symbol (Kraken-formatted) -> tracker. */
  readonly #trackers = new Map<string, TopOfBookTracker>();

  constructor(readonly options: KrakenClientOptions) {}

  get status(): "idle" | "connecting" | "connected" | "reconnecting" | "stopped" {
    return this.#status;
  }
  get lastTickAtMs(): number | null { return this.#lastTickAtMs; }

  start(): void {
    if (this.options.signal.aborted) {return;}
    this.options.signal.addEventListener("abort", () => this.stop(), { once: true });
    void this.#runForever();
  }

  stop(): void {
    if (this.#stopped) {return;}
    this.#stopped = true;
    this.#status = "stopped";
    if (this.#ws) { try { this.#ws.close(); } catch { /* ignore */ } this.#ws = null; }
  }

  async #runForever(): Promise<void> {
    while (!this.#stopped) {
      try { await this.#connectOnce(); }
      catch (error) {
        if (this.#stopped) {return;}
        const err = error instanceof Error ? error : new Error(String(error));
        this.options.onError?.(err);
        logger.warn("kraken ws connect failed", {
          component: "kraken_ws", message: err.message, delayMs: this.#reconnectDelayMs,
        });
      }
      if (this.#stopped) {return;}
      this.#status = "reconnecting";
      await sleep(this.#reconnectDelayMs);
      this.#reconnectDelayMs = Math.min(this.#reconnectDelayMs * 2, RECONNECT_MAX_MS);
    }
  }

  async #connectOnce(): Promise<void> {
    this.#status = "connecting";
    this.#trackers.clear();
    const ws = new WebSocket(this.options.url);
    this.#ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => { ws.off("error", onError); resolve(); };
      const onError = (error: Error): void => { ws.off("open", onOpen); reject(error); };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });

    this.#status = "connected";
    this.#reconnectDelayMs = RECONNECT_INITIAL_MS;
    this.options.onOpen?.();
    this.#sendSubscription();

    await new Promise<void>((resolve) => {
      ws.on("message", (data) => this.#handleMessage(data));
      ws.on("close", (code, reason) => { this.options.onClose?.(code, reason.toString()); resolve(); });
      ws.on("error", (error) => { this.options.onError?.(error); });
    });
  }

  #sendSubscription(): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {return;}
    const payload = {
      method: "subscribe",
      params: {
        channel: "book",
        symbol: this.options.symbols.map(toKrakenSymbol),
        depth: 10,
      },
    };
    try { this.#ws.send(JSON.stringify(payload)); }
    catch (error) {
      logger.warn("kraken ws send subscription failed", {
        component: "kraken_ws",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #handleMessage(data: WebSocket.RawData): void {
    const text = rawDataToString(data);
    if (text.length === 0) {return;}
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return; }
    const frame = bookFrameSchema.safeParse(parsed);
    if (!frame.success) {return;}

    for (const entry of frame.data.data) {
      let tracker = this.#trackers.get(entry.symbol);
      if (!tracker) {
        tracker = new TopOfBookTracker();
        this.#trackers.set(entry.symbol, tracker);
      }
      if (frame.data.type === "snapshot") {
        const bids: bigint[] = [];
        const asks: bigint[] = [];
        for (const lvl of entry.bids) {
          const p = parseE8(lvl.price);
          if (p !== null) {bids.push(p);}
        }
        for (const lvl of entry.asks) {
          const p = parseE8(lvl.price);
          if (p !== null) {asks.push(p);}
        }
        tracker.resetSnapshot({ bids, asks });
      } else {
        for (const lvl of entry.bids) {
          const p = parseE8(lvl.price);
          if (p === null) {continue;}
          const qty = Number(lvl.qty);
          if (!Number.isFinite(qty)) {continue;}
          if (qty === 0) {tracker.removeBid(p);} else {tracker.setBid(p);}
        }
        for (const lvl of entry.asks) {
          const p = parseE8(lvl.price);
          if (p === null) {continue;}
          const qty = Number(lvl.qty);
          if (!Number.isFinite(qty)) {continue;}
          if (qty === 0) {tracker.removeAsk(p);} else {tracker.setAsk(p);}
        }
      }

      const top = tracker.topOfBook();
      const midE8 =
        top.bidE8 !== null && top.askE8 !== null ? (top.bidE8 + top.askE8) / 2n : null;
      const receivedAtMs = Date.now();
      this.#lastTickAtMs = receivedAtMs;
      const eventMs = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
      this.options.onTick({
        source: "kraken",
        symbol: fromKrakenSymbol(entry.symbol),
        exchangePair: entry.symbol,
        receivedAtMs,
        eventMs: Number.isFinite(eventMs) ? eventMs : null,
        priceE8: midE8,
        bidE8: top.bidE8,
        askE8: top.askE8,
        bidSizeE8: null,
        askSizeE8: null,
        sequence: typeof entry.checksum === "number" ? BigInt(entry.checksum) : null,
        raw: parsed,
      });
    }
  }
}
