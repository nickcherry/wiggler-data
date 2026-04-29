import { assetPriceToE8 } from "@wiggler/lib/domain/decimal";
import { logger } from "@wiggler/lib/logging/logger";
import {
  fromBinanceSymbol,
  toBinanceSymbol,
} from "@wiggler/lib/prices/symbols";
import type { PriceTick } from "@wiggler/lib/prices/types";
import { sleep } from "@wiggler/lib/util/sleep";
import WebSocket from "ws";
import { z } from "zod";

const numericString = z.union([z.string(), z.number()]);

/**
 * Binance bookTicker frame. Fields:
 *   u — order book updateId
 *   s — symbol
 *   b/B — best bid price/qty
 *   a/A — best ask price/qty
 *
 * When using the combined-streams endpoint frames are wrapped in
 * `{ stream, data }`, which the schema below accepts via `.passthrough()`.
 */
const bookTickerSchema = z.object({
  u: z.number().optional(),
  s: z.string(),
  b: numericString,
  B: numericString.optional(),
  a: numericString,
  A: numericString.optional(),
});

const combinedStreamSchema = z.object({
  stream: z.string(),
  data: bookTickerSchema,
});

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export type BinanceClientOptions = Readonly<{
  url: string;
  symbols: readonly string[];
  signal: AbortSignal;
  onTick: (tick: PriceTick) => void;
  onError?: (error: Error) => void;
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
}>;

/**
 * Subscribes to Binance Spot's `<symbol>@bookTicker` streams using the
 * combined-streams endpoint. Each frame is the latest best bid/ask for one
 * symbol; bookTicker fires on every change and is the densest "BTC right now"
 * signal Binance offers without auth.
 */
export class BinanceBookTickerClient {
  #ws: WebSocket | null = null;
  #stopped = false;
  #reconnectDelayMs = RECONNECT_INITIAL_MS;
  #lastTickAtMs: number | null = null;
  #status: "idle" | "connecting" | "connected" | "reconnecting" | "stopped" = "idle";

  constructor(readonly options: BinanceClientOptions) {}

  get status(): "idle" | "connecting" | "connected" | "reconnecting" | "stopped" {
    return this.#status;
  }

  get lastTickAtMs(): number | null {
    return this.#lastTickAtMs;
  }

  start(): void {
    if (this.options.signal.aborted) {
      return;
    }
    this.options.signal.addEventListener("abort", () => this.stop(), { once: true });
    void this.#runForever();
  }

  stop(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#status = "stopped";
    if (this.#ws) {
      try {
        this.#ws.close();
      } catch {
        // ignore
      }
      this.#ws = null;
    }
  }

  async #runForever(): Promise<void> {
    while (!this.#stopped) {
      try {
        await this.#connectOnce();
      } catch (error) {
        if (this.#stopped) {
          return;
        }
        const err = error instanceof Error ? error : new Error(String(error));
        this.options.onError?.(err);
        logger.warn("binance ws connect failed", {
          component: "binance_ws",
          message: err.message,
          delayMs: this.#reconnectDelayMs,
        });
      }
      if (this.#stopped) {
        return;
      }
      this.#status = "reconnecting";
      await sleep(this.#reconnectDelayMs);
      this.#reconnectDelayMs = Math.min(this.#reconnectDelayMs * 2, RECONNECT_MAX_MS);
    }
  }

  async #connectOnce(): Promise<void> {
    this.#status = "connecting";
    const streams = this.options.symbols
      .map((symbol) => `${toBinanceSymbol(symbol).toLowerCase()}@bookTicker`)
      .join("/");
    const url = `${this.options.url.replace(/\/$/, "")}/stream?streams=${streams}`;
    const ws = new WebSocket(url);
    this.#ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        ws.off("error", onError);
        resolve();
      };
      const onError = (error: Error): void => {
        ws.off("open", onOpen);
        reject(error);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });

    this.#status = "connected";
    this.#reconnectDelayMs = RECONNECT_INITIAL_MS;
    this.options.onOpen?.();

    await new Promise<void>((resolve) => {
      ws.on("message", (data) => this.#handleMessage(data));
      ws.on("close", (code, reason) => {
        this.options.onClose?.(code, reason.toString());
        resolve();
      });
      ws.on("error", (error) => {
        this.options.onError?.(error);
      });
    });
  }

  #handleMessage(data: WebSocket.RawData): void {
    const text = rawDataToString(data);
    if (text.length === 0) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const combined = combinedStreamSchema.safeParse(parsed);
    const event = combined.success
      ? combined.data.data
      : extractBareBookTicker(parsed);
    if (!event) {
      return;
    }
    const receivedAtMs = Date.now();
    this.#lastTickAtMs = receivedAtMs;
    const tick = projectTick({ event, raw: parsed, receivedAtMs });
    if (tick) {
      this.options.onTick(tick);
    }
  }
}

function extractBareBookTicker(payload: unknown): z.infer<typeof bookTickerSchema> | null {
  const result = bookTickerSchema.safeParse(payload);
  return result.success ? result.data : null;
}

function projectTick(args: {
  event: z.infer<typeof bookTickerSchema>;
  raw: unknown;
  receivedAtMs: number;
}): PriceTick | null {
  const { event, raw, receivedAtMs } = args;
  const symbol = fromBinanceSymbol(event.s);
  const bidE8 = parsePrice(event.b);
  const askE8 = parsePrice(event.a);
  const midE8 = bidE8 !== null && askE8 !== null ? (bidE8 + askE8) / 2n : null;

  return {
    source: "binance",
    symbol,
    exchangePair: event.s,
    receivedAtMs,
    eventMs: null,
    priceE8: midE8,
    bidE8,
    askE8,
    bidSizeE8: parsePrice(event.B),
    askSizeE8: parsePrice(event.A),
    sequence: typeof event.u === "number" ? BigInt(event.u) : null,
    raw,
  };
}

function parsePrice(value: string | number | undefined): bigint | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  try {
    return assetPriceToE8(value);
  } catch {
    return null;
  }
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
