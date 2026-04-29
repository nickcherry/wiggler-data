import { logger } from "@wiggler/lib/logging/logger";
import { fromBybitSymbol, toBybitSymbol } from "@wiggler/lib/prices/symbols";
import type { PriceTick } from "@wiggler/lib/prices/types";
import { parseE8, rawDataToString } from "@wiggler/lib/prices/wsHelpers";
import { sleep } from "@wiggler/lib/util/sleep";
import WebSocket from "ws";
import { z } from "zod";

const numericString = z.union([z.string(), z.number()]);
const priceSizeTuple = z.tuple([numericString, numericString]);

/**
 * Bybit v5 spot orderbook frame for `orderbook.1.<SYMBOL>`. With depth=1 the
 * `b` and `a` arrays each contain at most one `[price, size]` tuple — when
 * one side is unchanged it may arrive empty, so the client retains the last
 * known best bid/ask across frames.
 */
const orderbookFrameSchema = z.object({
  topic: z.string(),
  ts: z.number().optional(),
  type: z.string(),
  data: z.object({
    s: z.string(),
    b: z.array(priceSizeTuple),
    a: z.array(priceSizeTuple),
    u: z.number().optional(),
    seq: z.number().optional(),
  }),
});

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const PING_INTERVAL_MS = 20_000;

export type BybitClientOptions = Readonly<{
  url: string;
  symbols: readonly string[];
  signal: AbortSignal;
  onTick: (tick: PriceTick) => void;
  onError?: (error: Error) => void;
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
}>;

/**
 * Subscribes to Bybit Spot's `orderbook.1.<SYMBOL>USDT` topics. Bybit pushes
 * depth-1 snapshots on every BBO change, which is dense enough (~30/s on
 * BTCUSDT) for the 1s scheduler cadence without a book reducer. We track
 * the most recent best bid/ask per symbol because Bybit may send "delta"
 * frames where one side is empty.
 */
export class BybitOrderbookClient {
  #ws: WebSocket | null = null;
  #stopped = false;
  #reconnectDelayMs = RECONNECT_INITIAL_MS;
  #lastTickAtMs: number | null = null;
  #status: "idle" | "connecting" | "connected" | "reconnecting" | "stopped" = "idle";
  /** Last known top-of-book per symbol, retained across delta frames. */
  readonly #lastBidAsk = new Map<string, { bidE8: bigint | null; askE8: bigint | null }>();

  constructor(readonly options: BybitClientOptions) {}

  get status(): "idle" | "connecting" | "connected" | "reconnecting" | "stopped" {
    return this.#status;
  }

  get lastTickAtMs(): number | null {
    return this.#lastTickAtMs;
  }

  start(): void {
    if (this.options.signal.aborted) {return;}
    this.options.signal.addEventListener("abort", () => this.stop(), { once: true });
    void this.#runForever();
  }

  stop(): void {
    if (this.#stopped) {return;}
    this.#stopped = true;
    this.#status = "stopped";
    if (this.#ws) {
      try { this.#ws.close(); } catch { /* ignore */ }
      this.#ws = null;
    }
  }

  async #runForever(): Promise<void> {
    while (!this.#stopped) {
      try {
        await this.#connectOnce();
      } catch (error) {
        if (this.#stopped) {return;}
        const err = error instanceof Error ? error : new Error(String(error));
        this.options.onError?.(err);
        logger.warn("bybit ws connect failed", {
          component: "bybit_ws",
          message: err.message,
          delayMs: this.#reconnectDelayMs,
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
    this.#lastBidAsk.clear();
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

    const pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ op: "ping" })); } catch { /* ignore */ }
      }
    }, PING_INTERVAL_MS);

    await new Promise<void>((resolve) => {
      ws.on("message", (data) => this.#handleMessage(data));
      ws.on("close", (code, reason) => {
        clearInterval(pingTimer);
        this.options.onClose?.(code, reason.toString());
        resolve();
      });
      ws.on("error", (error) => {
        this.options.onError?.(error);
      });
    });
  }

  #sendSubscription(): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {return;}
    const args = this.options.symbols.map((s) => `orderbook.1.${toBybitSymbol(s)}`);
    try {
      this.#ws.send(JSON.stringify({ op: "subscribe", args }));
    } catch (error) {
      logger.warn("bybit ws send subscription failed", {
        component: "bybit_ws",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #handleMessage(data: WebSocket.RawData): void {
    const text = rawDataToString(data);
    if (text.length === 0) {return;}
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return; }
    const result = orderbookFrameSchema.safeParse(parsed);
    if (!result.success) {return;}
    const event = result.data;
    if (!event.topic.startsWith("orderbook.")) {return;}

    const receivedAtMs = Date.now();
    const symbol = fromBybitSymbol(event.data.s);

    const prior = this.#lastBidAsk.get(event.data.s) ?? { bidE8: null, askE8: null };
    const newBidE8 = event.data.b[0] ? parseE8(event.data.b[0][0]) : prior.bidE8;
    const newAskE8 = event.data.a[0] ? parseE8(event.data.a[0][0]) : prior.askE8;
    const next = { bidE8: newBidE8, askE8: newAskE8 };
    this.#lastBidAsk.set(event.data.s, next);

    const midE8 =
      next.bidE8 !== null && next.askE8 !== null
        ? (next.bidE8 + next.askE8) / 2n
        : null;

    this.#lastTickAtMs = receivedAtMs;
    this.options.onTick({
      source: "bybit",
      symbol,
      exchangePair: event.data.s,
      receivedAtMs,
      eventMs: typeof event.ts === "number" ? event.ts : null,
      priceE8: midE8,
      bidE8: next.bidE8,
      askE8: next.askE8,
      bidSizeE8: event.data.b[0] ? parseE8(event.data.b[0][1]) : null,
      askSizeE8: event.data.a[0] ? parseE8(event.data.a[0][1]) : null,
      sequence: typeof event.data.u === "number" ? BigInt(event.data.u) : null,
      raw: parsed,
    });
  }
}
