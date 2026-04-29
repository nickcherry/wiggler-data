import { env } from "@wiggler/constants/env";
import { logger } from "@wiggler/lib/logging/logger";
import { sleep } from "@wiggler/lib/util/sleep";
import WebSocket from "ws";

export type WsClientStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "stopped";

export type WsClientEvents = Readonly<{
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (error: Error) => void;
  onMessage: (raw: unknown, receivedAtMs: number) => void;
}>;

const PING_INTERVAL_MS = 10_000;
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Polymarket market-channel WebSocket client. Owns the connection lifecycle,
 * resubscribes on reconnect, and ships parsed JSON events to the supplied
 * handler. The server expects an array of asset ids in the subscription frame.
 */
export class PolymarketWsClient {
  #status: WsClientStatus = "idle";
  #ws: WebSocket | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #reconnectDelayMs = RECONNECT_INITIAL_MS;
  #stopped = false;
  /** Asset ids the caller has asked us to subscribe to. Sent in full on every fresh connection. */
  #assetIds: ReadonlySet<string> = new Set();
  #lastEventAtMs: number | null = null;
  #connectedAtMs: number | null = null;

  constructor(
    readonly events: WsClientEvents,
    readonly url: string = env.polymarketWsUrl,
  ) {}

  get status(): WsClientStatus {
    return this.#status;
  }

  get lastEventAtMs(): number | null {
    return this.#lastEventAtMs;
  }

  get connectedAtMs(): number | null {
    return this.#connectedAtMs;
  }

  get subscribedAssetIds(): readonly string[] {
    return [...this.#assetIds];
  }

  start(assetIds: Iterable<string>, signal: AbortSignal): void {
    this.#assetIds = new Set(assetIds);
    this.#stopped = false;
    if (signal.aborted) {
      return;
    }
    signal.addEventListener("abort", () => this.stop(), { once: true });
    void this.#runForever();
  }

  /**
   * Updates the desired subscription set. Polymarket's market WS does not
   * accept mid-connection subscribe frames at all — both re-subscribing an
   * existing asset_id and adding a new one are rejected with the literal
   * string `INVALID OPERATION`, and the rejected asset_id is silently NOT
   * added to the server's subscription list (verified by observing zero
   * inbound events for the rejected asset_id afterward).
   *
   * The only reliable way to expand the subscription set is to close the
   * current connection and let `#runForever` open a new one, which sends a
   * fresh `subscribe` frame with the full current set as the connection's
   * first message. Cost is one ~1s reconnect window per new-market discovery
   * (~once every 5 minutes in steady state).
   */
  updateSubscriptions(assetIds: Iterable<string>): void {
    const next = new Set(assetIds);
    const prev = this.#assetIds;
    if (sameSet(prev, next)) {
      return;
    }
    this.#assetIds = next;
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      return;
    }
    // Only reconnect when there are NEW asset_ids that the server doesn't
    // know about yet. Pure removals (markets pruned after they resolved)
    // are not worth a reconnect — those markets stop emitting on their own
    // and their leftover server-side subscription costs nothing.
    const hasAdditions = [...next].some((id) => !prev.has(id));
    if (!hasAdditions) {
      return;
    }
    logger.info("polymarket ws cycling connection for subscription change", {
      component: "polymarket_ws",
      desiredAssets: next.size,
      newAssets: [...next].filter((id) => !prev.has(id)).length,
    });
    try {
      this.#ws.close();
    } catch {
      // ignore; #runForever will reconnect either way
    }
  }

  stop(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#status = "stopped";
    this.#clearPing();
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
        this.events.onError?.(err);
        logger.warn("polymarket ws connect failed", {
          component: "polymarket_ws",
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
    const ws = new WebSocket(this.url);
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
    this.#connectedAtMs = Date.now();
    this.#reconnectDelayMs = RECONNECT_INITIAL_MS;
    this.events.onOpen?.();

    // Send the full subscription set as the connection's first frame.
    // Polymarket only accepts subscribes once per connection (see
    // updateSubscriptions for the rationale), so this is our only chance.
    const initialAssets = [...this.#assetIds];
    if (initialAssets.length > 0) {
      this.#sendSubscriptionFrame(initialAssets);
    }
    this.#startPing();

    await new Promise<void>((resolve) => {
      ws.on("message", (data) => this.#handleMessage(data));
      ws.on("close", (code, reason) => {
        this.#clearPing();
        this.events.onClose?.(code, reason.toString());
        resolve();
      });
      ws.on("error", (error) => {
        this.events.onError?.(error);
      });
    });
  }

  #handleMessage(data: WebSocket.RawData): void {
    const text = rawDataToString(data);
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    const upper = trimmed.toUpperCase();
    if (upper === "PONG") {
      // Heartbeat reply. Connection is healthy.
      return;
    }
    if (upper === "INVALID OPERATION") {
      // Polymarket's text response when we send an unrecognized frame
      // (e.g. re-subscribing an already-subscribed asset_id). Should not
      // happen now that subscribes are additive, but stays observable so
      // we notice if the server protocol shifts.
      logger.warn("polymarket ws rejected frame", {
        component: "polymarket_ws",
        message: trimmed,
      });
      return;
    }
    const receivedAtMs = Date.now();
    this.#lastEventAtMs = receivedAtMs;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      logger.warn("polymarket ws non-json frame", {
        component: "polymarket_ws",
        sample: trimmed.slice(0, 200),
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        this.events.onMessage(item, receivedAtMs);
      }
      return;
    }
    this.events.onMessage(parsed, receivedAtMs);
  }

  /**
   * Sends a single subscribe frame for the given asset ids. Caller is
   * responsible for tracking what has already been subscribed on this
   * connection so the same id is never sent twice.
   */
  #sendSubscriptionFrame(assetIds: readonly string[]): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN || assetIds.length === 0) {
      return;
    }
    const payload = {
      type: "market",
      assets_ids: assetIds,
    };
    try {
      this.#ws.send(JSON.stringify(payload));
    } catch (error) {
      logger.warn("polymarket ws send subscription failed", {
        component: "polymarket_ws",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #startPing(): void {
    this.#clearPing();
    this.#pingTimer = setInterval(() => {
      if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
        try {
          this.#ws.send("PING");
        } catch {
          // ignore; next reconnect cycle handles it
        }
      }
    }, PING_INTERVAL_MS);
  }

  #clearPing(): void {
    if (this.#pingTimer) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
  }
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const item of a) {
    if (!b.has(item)) {
      return false;
    }
  }
  return true;
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
