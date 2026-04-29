import { assetPriceToE8 } from "@wiggler/lib/domain/decimal";
import { logger } from "@wiggler/lib/logging/logger";
import {
  fromCoinbaseProductId,
  toCoinbaseProductId,
} from "@wiggler/lib/prices/symbols";
import type { PriceTick } from "@wiggler/lib/prices/types";
import { sleep } from "@wiggler/lib/util/sleep";
import WebSocket from "ws";
import { z } from "zod";

const numericString = z.union([z.string(), z.number()]);

const tickerEventSchema = z.object({
  type: z.literal("ticker"),
  sequence: z.union([z.number(), z.string()]).optional(),
  product_id: z.string(),
  price: numericString.optional(),
  best_bid: numericString.optional(),
  best_ask: numericString.optional(),
  best_bid_size: numericString.optional(),
  best_ask_size: numericString.optional(),
  time: z.string().optional(),
});

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export type CoinbaseClientOptions = Readonly<{
  url: string;
  symbols: readonly string[];
  signal: AbortSignal;
  onTick: (tick: PriceTick) => void;
  onError?: (error: Error) => void;
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
}>;

/**
 * Subscribes to Coinbase Exchange's `ticker` channel for one or more
 * `<SYMBOL>-USD` products. The channel emits an event on every trade with the
 * latest best bid/ask alongside the trade price, which is dense enough for
 * cross-source price comparison.
 */
export class CoinbaseTickerClient {
  #ws: WebSocket | null = null;
  #stopped = false;
  #reconnectDelayMs = RECONNECT_INITIAL_MS;
  #lastTickAtMs: number | null = null;
  #status: "idle" | "connecting" | "connected" | "reconnecting" | "stopped" = "idle";

  constructor(readonly options: CoinbaseClientOptions) {}

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
        logger.warn("coinbase ws connect failed", {
          component: "coinbase_ws",
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
    const ws = new WebSocket(this.options.url);
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

    this.#sendSubscription();

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

  #sendSubscription(): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const productIds = this.options.symbols.map(toCoinbaseProductId);
    const payload = {
      type: "subscribe",
      product_ids: productIds,
      channels: ["ticker"],
    };
    try {
      this.#ws.send(JSON.stringify(payload));
    } catch (error) {
      logger.warn("coinbase ws send subscription failed", {
        component: "coinbase_ws",
        message: error instanceof Error ? error.message : String(error),
      });
    }
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
    const result = tickerEventSchema.safeParse(parsed);
    if (!result.success) {
      return;
    }
    const event = result.data;
    const receivedAtMs = Date.now();
    this.#lastTickAtMs = receivedAtMs;
    const tick = projectTick({ event, raw: parsed, receivedAtMs });
    if (tick) {
      this.options.onTick(tick);
    }
  }
}

function projectTick(args: {
  event: z.infer<typeof tickerEventSchema>;
  raw: unknown;
  receivedAtMs: number;
}): PriceTick | null {
  const { event, raw, receivedAtMs } = args;
  const symbol = fromCoinbaseProductId(event.product_id);
  const bidE8 = parsePrice(event.best_bid);
  const askE8 = parsePrice(event.best_ask);
  const lastE8 = parsePrice(event.price);
  const midE8 = bidE8 !== null && askE8 !== null ? (bidE8 + askE8) / 2n : null;
  const priceE8 = midE8 ?? lastE8;
  const eventMs = event.time ? Date.parse(event.time) : NaN;

  return {
    source: "coinbase",
    symbol,
    exchangePair: event.product_id,
    receivedAtMs,
    eventMs: Number.isFinite(eventMs) ? eventMs : null,
    priceE8,
    bidE8,
    askE8,
    bidSizeE8: parseSize(event.best_bid_size),
    askSizeE8: parseSize(event.best_ask_size),
    sequence: parseSequence(event.sequence),
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

function parseSize(value: string | number | undefined): bigint | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  try {
    return assetPriceToE8(value);
  } catch {
    return null;
  }
}

function parseSequence(value: string | number | undefined): bigint | null {
  if (value === undefined || value === null) {
    return null;
  }
  try {
    return BigInt(typeof value === "number" ? Math.trunc(value) : value);
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
