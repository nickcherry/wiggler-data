import { logger } from "@wiggler/lib/logging/logger";
import { fromGeminiSymbol, toGeminiSymbol } from "@wiggler/lib/prices/symbols";
import type { PriceTick } from "@wiggler/lib/prices/types";
import { parseE8, rawDataToString } from "@wiggler/lib/prices/wsHelpers";
import { sleep } from "@wiggler/lib/util/sleep";
import WebSocket from "ws";
import { z } from "zod";

const numericString = z.union([z.string(), z.number()]);

/**
 * Gemini v1 marketdata top-of-book event. The first frame after subscribe
 * uses `reason: "initial"` and contains both sides; subsequent frames use
 * `reason: "top-of-book"` for one side at a time.
 */
const tobChangeSchema = z.object({
  type: z.literal("change"),
  side: z.enum(["bid", "ask"]),
  price: numericString,
  remaining: numericString.optional(),
  reason: z.string().optional(),
});

const updateFrameSchema = z.object({
  type: z.literal("update"),
  events: z.array(z.unknown()),
  timestampms: z.number().optional(),
  timestamp: z.number().optional(),
});

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export type GeminiClientOptions = Readonly<{
  /** Base URL like `wss://api.gemini.com/v1/marketdata`. The symbol is
   *  appended per connection. */
  baseUrl: string;
  symbols: readonly string[];
  signal: AbortSignal;
  onTick: (tick: PriceTick) => void;
  onError?: (error: Error) => void;
  onOpen?: (symbol: string) => void;
  onClose?: (symbol: string, code: number, reason: string) => void;
}>;

/**
 * Subscribes to Gemini v1 marketdata's top-of-book change stream for one or
 * more symbols. Gemini's WS API uses one socket per symbol (the URL itself
 * carries the symbol), so this client multiplexes one inner connection per
 * subscribed symbol and surfaces a single combined `lastTickAtMs` and
 * status.
 *
 * The query string `top_of_book=true&bids=true&offers=true&trades=false`
 * ensures only top-of-book changes are emitted (~30/s on BTCUSD), which is
 * dense enough for the 1s scheduler cadence without maintaining the full
 * order book.
 */
export class GeminiTopOfBookClient {
  readonly #connections = new Map<string, SymbolConnection>();
  #stopped = false;
  #lastTickAtMs: number | null = null;

  constructor(readonly options: GeminiClientOptions) {}

  get status(): "idle" | "connecting" | "connected" | "reconnecting" | "stopped" {
    if (this.#stopped) {return "stopped";}
    if (this.#connections.size === 0) {return "idle";}
    let anyConnected = false;
    let anyConnecting = false;
    for (const c of this.#connections.values()) {
      if (c.status === "connected") {anyConnected = true;}
      if (c.status === "connecting" || c.status === "reconnecting") {anyConnecting = true;}
    }
    if (anyConnected) {return "connected";}
    if (anyConnecting) {return "connecting";}
    return "reconnecting";
  }
  get lastTickAtMs(): number | null { return this.#lastTickAtMs; }

  start(): void {
    if (this.options.signal.aborted) {return;}
    this.options.signal.addEventListener("abort", () => this.stop(), { once: true });
    for (const symbol of this.options.symbols) {
      const conn = new SymbolConnection({
        symbol,
        baseUrl: this.options.baseUrl,
        onTick: (tick) => {
          this.#lastTickAtMs = tick.receivedAtMs;
          this.options.onTick(tick);
        },
        onError: this.options.onError,
        onOpen: this.options.onOpen,
        onClose: this.options.onClose,
        signal: this.options.signal,
      });
      this.#connections.set(symbol, conn);
      conn.start();
    }
  }

  stop(): void {
    if (this.#stopped) {return;}
    this.#stopped = true;
    for (const c of this.#connections.values()) {c.stop();}
  }
}

type SymbolConnectionOptions = Readonly<{
  symbol: string;
  baseUrl: string;
  signal: AbortSignal;
  onTick: (tick: PriceTick) => void;
  onError?: (error: Error) => void;
  onOpen?: (symbol: string) => void;
  onClose?: (symbol: string, code: number, reason: string) => void;
}>;

class SymbolConnection {
  #ws: WebSocket | null = null;
  #stopped = false;
  #reconnectDelayMs = RECONNECT_INITIAL_MS;
  #status: "idle" | "connecting" | "connected" | "reconnecting" | "stopped" = "idle";
  /** Last-known top of book per side, retained across single-side update frames. */
  #bidE8: bigint | null = null;
  #askE8: bigint | null = null;

  constructor(readonly options: SymbolConnectionOptions) {}

  get status(): "idle" | "connecting" | "connected" | "reconnecting" | "stopped" {
    return this.#status;
  }

  start(): void { void this.#runForever(); }
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
        logger.warn("gemini ws connect failed", {
          component: "gemini_ws", symbol: this.options.symbol,
          message: err.message, delayMs: this.#reconnectDelayMs,
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
    this.#bidE8 = null;
    this.#askE8 = null;
    const url = buildGeminiUrl(this.options.baseUrl, this.options.symbol);
    const ws = new WebSocket(url);
    this.#ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => { ws.off("error", onError); resolve(); };
      const onError = (error: Error): void => { ws.off("open", onOpen); reject(error); };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });

    this.#status = "connected";
    this.#reconnectDelayMs = RECONNECT_INITIAL_MS;
    this.options.onOpen?.(this.options.symbol);

    await new Promise<void>((resolve) => {
      ws.on("message", (data) => this.#handleMessage(data));
      ws.on("close", (code, reason) => {
        this.options.onClose?.(this.options.symbol, code, reason.toString());
        resolve();
      });
      ws.on("error", (error) => { this.options.onError?.(error); });
    });
  }

  #handleMessage(data: WebSocket.RawData): void {
    const text = rawDataToString(data);
    if (text.length === 0) {return;}
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return; }
    const frame = updateFrameSchema.safeParse(parsed);
    if (!frame.success) {return;}

    let mutated = false;
    for (const ev of frame.data.events) {
      const change = tobChangeSchema.safeParse(ev);
      if (!change.success) {continue;}
      const priceE8 = parseE8(change.data.price);
      if (priceE8 === null) {continue;}
      const remaining = parseE8(change.data.remaining);
      if (change.data.side === "bid") {
        // qty=0 invalidates the bid; otherwise the change is a new top bid.
        this.#bidE8 = remaining === 0n ? null : priceE8;
        mutated = true;
      } else {
        this.#askE8 = remaining === 0n ? null : priceE8;
        mutated = true;
      }
    }
    if (!mutated) {return;}
    const receivedAtMs = Date.now();
    const midE8 =
      this.#bidE8 !== null && this.#askE8 !== null
        ? (this.#bidE8 + this.#askE8) / 2n
        : null;
    const eventMs = typeof frame.data.timestampms === "number"
      ? frame.data.timestampms
      : null;

    this.options.onTick({
      source: "gemini",
      symbol: fromGeminiSymbol(toGeminiSymbol(this.options.symbol)),
      exchangePair: toGeminiSymbol(this.options.symbol),
      receivedAtMs,
      eventMs,
      priceE8: midE8,
      bidE8: this.#bidE8,
      askE8: this.#askE8,
      bidSizeE8: null,
      askSizeE8: null,
      sequence: null,
      raw: parsed,
    });
  }
}

function buildGeminiUrl(base: string, symbol: string): string {
  const trimmed = base.replace(/\/$/, "");
  const pair = toGeminiSymbol(symbol);
  return `${trimmed}/${pair}?top_of_book=true&bids=true&offers=true&trades=false`;
}
