import { logger } from "@wiggler/lib/logging/logger";
import { fromBitstampSymbol, toBitstampSymbol } from "@wiggler/lib/prices/symbols";
import type { PriceTick } from "@wiggler/lib/prices/types";
import { parseE8, rawDataToString } from "@wiggler/lib/prices/wsHelpers";
import { sleep } from "@wiggler/lib/util/sleep";
import WebSocket from "ws";
import { z } from "zod";

const numericString = z.union([z.string(), z.number()]);
const priceSizeTuple = z.tuple([numericString, numericString]);

/**
 * Bitstamp `order_book_<pair>` frame. Each event contains the top-100 bids
 * and asks as an array of `[price, qty]` tuples sorted best-first, so
 * `bids[0]` and `asks[0]` are the current top-of-book.
 */
const orderBookEventSchema = z.object({
  event: z.literal("data"),
  channel: z.string(),
  data: z.object({
    timestamp: z.string().optional(),
    microtimestamp: z.string().optional(),
    bids: z.array(priceSizeTuple),
    asks: z.array(priceSizeTuple),
  }),
});

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const ORDER_BOOK_CHANNEL_PREFIX = "order_book_";

export type BitstampClientOptions = Readonly<{
  url: string;
  symbols: readonly string[];
  signal: AbortSignal;
  onTick: (tick: PriceTick) => void;
  onError?: (error: Error) => void;
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
}>;

/**
 * Subscribes to Bitstamp's `order_book_<pair>` channel for one or more
 * symbols. Each event already contains the top-100 bids and asks, so the
 * client can read top-of-book directly from each frame without maintaining
 * any additional book state.
 */
export class BitstampOrderBookClient {
  #ws: WebSocket | null = null;
  #stopped = false;
  #reconnectDelayMs = RECONNECT_INITIAL_MS;
  #lastTickAtMs: number | null = null;
  #status: "idle" | "connecting" | "connected" | "reconnecting" | "stopped" = "idle";

  constructor(readonly options: BitstampClientOptions) {}

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
        logger.warn("bitstamp ws connect failed", {
          component: "bitstamp_ws", message: err.message, delayMs: this.#reconnectDelayMs,
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
    this.#sendSubscriptions();

    await new Promise<void>((resolve) => {
      ws.on("message", (data) => this.#handleMessage(data));
      ws.on("close", (code, reason) => { this.options.onClose?.(code, reason.toString()); resolve(); });
      ws.on("error", (error) => { this.options.onError?.(error); });
    });
  }

  #sendSubscriptions(): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {return;}
    for (const symbol of this.options.symbols) {
      const channel = `${ORDER_BOOK_CHANNEL_PREFIX}${toBitstampSymbol(symbol)}`;
      try {
        this.#ws.send(JSON.stringify({ event: "bts:subscribe", data: { channel } }));
      } catch (error) {
        logger.warn("bitstamp ws send subscription failed", {
          component: "bitstamp_ws",
          channel,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  #handleMessage(data: WebSocket.RawData): void {
    const text = rawDataToString(data);
    if (text.length === 0) {return;}
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return; }
    const result = orderBookEventSchema.safeParse(parsed);
    if (!result.success) {return;}
    const event = result.data;
    if (!event.channel.startsWith(ORDER_BOOK_CHANNEL_PREFIX)) {return;}

    const receivedAtMs = Date.now();
    const pair = event.channel.slice(ORDER_BOOK_CHANNEL_PREFIX.length);
    const symbol = fromBitstampSymbol(pair);
    const bidE8 = event.data.bids[0] ? parseE8(event.data.bids[0][0]) : null;
    const askE8 = event.data.asks[0] ? parseE8(event.data.asks[0][0]) : null;
    const midE8 = bidE8 !== null && askE8 !== null ? (bidE8 + askE8) / 2n : null;
    const eventMs = parseEventMs(event.data.microtimestamp, event.data.timestamp);

    this.#lastTickAtMs = receivedAtMs;
    this.options.onTick({
      source: "bitstamp",
      symbol,
      exchangePair: pair,
      receivedAtMs,
      eventMs,
      priceE8: midE8,
      bidE8,
      askE8,
      bidSizeE8: event.data.bids[0] ? parseE8(event.data.bids[0][1]) : null,
      askSizeE8: event.data.asks[0] ? parseE8(event.data.asks[0][1]) : null,
      sequence: null,
      raw: parsed,
    });
  }
}

/**
 * Bitstamp gives event timestamps in two fields:
 *   - `microtimestamp` — unix microseconds as a string
 *   - `timestamp`      — unix seconds as a string
 * Prefer microtimestamp when present; fall back to seconds × 1000.
 */
function parseEventMs(micro: string | undefined, sec: string | undefined): number | null {
  if (micro !== undefined) {
    const us = Number(micro);
    if (Number.isFinite(us)) {return Math.round(us / 1000);}
  }
  if (sec !== undefined) {
    const s = Number(sec);
    if (Number.isFinite(s)) {return s * 1000;}
  }
  return null;
}
