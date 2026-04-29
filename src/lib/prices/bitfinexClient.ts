import { logger } from "@wiggler/lib/logging/logger";
import {
  fromBitfinexSymbol,
  toBitfinexSymbol,
} from "@wiggler/lib/prices/symbols";
import { TopOfBookTracker } from "@wiggler/lib/prices/topOfBookTracker";
import type { PriceTick } from "@wiggler/lib/prices/types";
import { parseE8, rawDataToString } from "@wiggler/lib/prices/wsHelpers";
import { sleep } from "@wiggler/lib/util/sleep";
import WebSocket from "ws";
import { z } from "zod";

const numericValue = z.union([z.number(), z.string()]);
const priceLevelSchema = z.tuple([numericValue, numericValue, numericValue]);

const eventFrameSchema = z.object({
  event: z.string(),
  channel: z.string().optional(),
  chanId: z.number().optional(),
  symbol: z.string().optional(),
});

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_PAYLOAD = "hb";

export type BitfinexClientOptions = Readonly<{
  url: string;
  symbols: readonly string[];
  signal: AbortSignal;
  onTick: (tick: PriceTick) => void;
  onError?: (error: Error) => void;
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
}>;

/**
 * Subscribes to Bitfinex's `book` channel (precision P0, freq F0, len 25)
 * for one or more symbols and projects each frame to a normalized
 * `PriceTick` with the current top of book.
 *
 * Bitfinex sends an initial snapshot of all 25 bid + 25 ask levels, then
 * incremental updates of `[price, count, amount]` triples. `count == 0`
 * means delete; the sign of `amount` (`+` for bid, `-` for ask) selects
 * which side a level belongs to. We track all levels in
 * `TopOfBookTracker` per channel and emit a tick whenever the top changes.
 */
export class BitfinexBookClient {
  #ws: WebSocket | null = null;
  #stopped = false;
  #reconnectDelayMs = RECONNECT_INITIAL_MS;
  #lastTickAtMs: number | null = null;
  #status: "idle" | "connecting" | "connected" | "reconnecting" | "stopped" = "idle";
  /** chanId -> { symbol, tracker } subscription state. */
  readonly #channels = new Map<number, { symbol: string; tracker: TopOfBookTracker }>();

  constructor(readonly options: BitfinexClientOptions) {}

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
        logger.warn("bitfinex ws connect failed", {
          component: "bitfinex_ws", message: err.message, delayMs: this.#reconnectDelayMs,
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
    this.#channels.clear();
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
      const payload = {
        event: "subscribe",
        channel: "book",
        symbol: toBitfinexSymbol(symbol),
        prec: "P0",
        freq: "F0",
        len: "25",
      };
      try { this.#ws.send(JSON.stringify(payload)); }
      catch (error) {
        logger.warn("bitfinex ws send subscription failed", {
          component: "bitfinex_ws",
          symbol,
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

    if (!Array.isArray(parsed)) {
      this.#handleEventFrame(parsed);
      return;
    }
    if (parsed.length !== 2) {return;}
    const [chanIdRaw, payload] = parsed as [unknown, unknown];
    if (typeof chanIdRaw !== "number") {return;}
    if (payload === HEARTBEAT_PAYLOAD) {return;}
    const channel = this.#channels.get(chanIdRaw);
    if (!channel) {return;}
    if (!Array.isArray(payload)) {return;}

    // Snapshot frames are array-of-arrays; updates are a single triple.
    const updates = isArrayOfArrays(payload)
      ? (payload as unknown[]).map((row) => priceLevelSchema.safeParse(row))
      : [priceLevelSchema.safeParse(payload)];
    const valid = updates.filter((r) => r.success).map((r) => r.data);
    if (valid.length === 0) {return;}

    const isSnapshot = isArrayOfArrays(payload);
    if (isSnapshot) {
      const bids: bigint[] = [];
      const asks: bigint[] = [];
      for (const [priceRaw, , amountRaw] of valid) {
        const priceE8 = parseE8(priceRaw);
        if (priceE8 === null) {continue;}
        const amountNum = Number(amountRaw);
        if (!Number.isFinite(amountNum)) {continue;}
        if (amountNum > 0) {bids.push(priceE8);}
        else if (amountNum < 0) {asks.push(priceE8);}
      }
      channel.tracker.resetSnapshot({ bids, asks });
    } else {
      for (const [priceRaw, countRaw, amountRaw] of valid) {
        const priceE8 = parseE8(priceRaw);
        if (priceE8 === null) {continue;}
        const count = Number(countRaw);
        const amount = Number(amountRaw);
        if (!Number.isFinite(count) || !Number.isFinite(amount)) {continue;}
        if (count === 0) {
          // Bitfinex uses the sign of `amount` to indicate which side to
          // remove the level from when count==0: +1 -> bid, -1 -> ask.
          if (amount > 0) {channel.tracker.removeBid(priceE8);}
          else if (amount < 0) {channel.tracker.removeAsk(priceE8);}
        } else {
          if (amount > 0) {channel.tracker.setBid(priceE8);}
          else if (amount < 0) {channel.tracker.setAsk(priceE8);}
        }
      }
    }

    const top = channel.tracker.topOfBook();
    const midE8 =
      top.bidE8 !== null && top.askE8 !== null ? (top.bidE8 + top.askE8) / 2n : null;
    const receivedAtMs = Date.now();
    this.#lastTickAtMs = receivedAtMs;
    this.options.onTick({
      source: "bitfinex",
      symbol: fromBitfinexSymbol(channel.symbol),
      exchangePair: channel.symbol,
      receivedAtMs,
      eventMs: null,
      priceE8: midE8,
      bidE8: top.bidE8,
      askE8: top.askE8,
      bidSizeE8: null,
      askSizeE8: null,
      sequence: null,
      raw: parsed,
    });
  }

  #handleEventFrame(parsed: unknown): void {
    const result = eventFrameSchema.safeParse(parsed);
    if (!result.success) {return;}
    const event = result.data;
    if (event.event === "subscribed" && event.channel === "book" && typeof event.chanId === "number" && event.symbol) {
      this.#channels.set(event.chanId, {
        symbol: event.symbol,
        tracker: new TopOfBookTracker(),
      });
      return;
    }
    if (event.event === "error") {
      logger.warn("bitfinex ws error frame", { component: "bitfinex_ws", payload: parsed });
    }
  }
}

function isArrayOfArrays(value: unknown[]): boolean {
  return value.length > 0 && Array.isArray(value[0]);
}
