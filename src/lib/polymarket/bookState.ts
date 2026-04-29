import { priceToE6, sizeToE6 } from "@wiggler/lib/domain/decimal";
import {
  normalizeSide,
  type PriceChangeSlice,
  type WsBookEvent,
  type WsTickSizeChangeEvent,
} from "@wiggler/lib/polymarket/wsEvents";
import { stableStringify } from "@wiggler/lib/util/json";

export type BookLevel = Readonly<{
  priceE6: bigint;
  sizeE6: bigint;
}>;

export type BookTopLevels = Readonly<{
  bids: readonly BookLevel[];
  asks: readonly BookLevel[];
}>;

/**
 * Reconstructed Polymarket orderbook for a single CLOB asset id (one outcome).
 */
export class BookState {
  readonly assetId: string;
  market?: string;
  tickSizeE6?: bigint;
  lastUpdateAtMs = 0;
  lastExchangeTimestampMs?: number;
  hasSnapshot = false;

  readonly #bids = new Map<string, bigint>();
  readonly #asks = new Map<string, bigint>();

  constructor(assetId: string) {
    this.assetId = assetId;
  }

  /**
   * Replaces the in-memory book with the contents of a `book` frame and
   * captures the frame's `tick_size` if present.
   */
  applySnapshot(event: WsBookEvent, receivedAtMs: number): void {
    this.market = event.market ?? this.market;
    this.lastUpdateAtMs = receivedAtMs;
    this.lastExchangeTimestampMs = parseTimestamp(event.timestamp);
    this.#bids.clear();
    this.#asks.clear();
    for (const level of event.bids) {
      this.#updateLevel("bid", priceToE6(level.price), sizeToE6(level.size));
    }
    for (const level of event.asks) {
      this.#updateLevel("ask", priceToE6(level.price), sizeToE6(level.size));
    }
    if (event.tick_size !== undefined) {
      try {
        this.tickSizeE6 = priceToE6(event.tick_size);
      } catch {
        // ignore unparseable tick size; keep existing
      }
    }
    this.hasSnapshot = true;
  }

  /**
   * Applies one per-asset slice of a `price_change` frame. The caller is
   * expected to dispatch each asset_id slice to its own BookState (multiple
   * asset_ids share a single inbound frame).
   */
  applyPriceChange(slice: PriceChangeSlice, receivedAtMs: number): void {
    this.market = slice.market ?? this.market;
    this.lastUpdateAtMs = receivedAtMs;
    this.lastExchangeTimestampMs = parseTimestamp(slice.timestamp);
    for (const entry of slice.entries) {
      const side = normalizeSide(entry.side) === "buy" ? "bid" : "ask";
      const priceE6 = priceToE6(entry.price);
      const sizeE6 = sizeToE6(entry.size);
      this.#updateLevel(side, priceE6, sizeE6);
    }
  }

  /** Updates the minimum tick size from a `tick_size_change` frame. */
  applyTickSizeChange(event: WsTickSizeChangeEvent, receivedAtMs: number): void {
    this.market = event.market ?? this.market;
    this.lastUpdateAtMs = receivedAtMs;
    this.lastExchangeTimestampMs = parseTimestamp(event.timestamp);
    this.tickSizeE6 = priceToE6(event.new_tick_size);
  }

  /** Returns the best (highest-priced) bid, or null if there are no bids. */
  getBestBid(): BookLevel | null {
    return getExtremeBid(this.#bids);
  }

  /** Returns the best (lowest-priced) ask, or null if there are no asks. */
  getBestAsk(): BookLevel | null {
    return getExtremeAsk(this.#asks);
  }

  /**
   * Returns the top `depth` levels per side, sorted (bids descending, asks
   * ascending). Used by the snapshot scheduler.
   */
  getTopLevels(depth: number): BookTopLevels {
    return {
      bids: collectSortedBids(this.#bids, depth),
      asks: collectSortedAsks(this.#asks, depth),
    };
  }

  /**
   * Returns true if the book is crossed (best bid >= best ask). Indicates a
   * data error or transient inconsistency rather than a normal book state.
   */
  isCrossed(): boolean {
    const bid = this.getBestBid();
    const ask = this.getBestAsk();
    if (!bid || !ask) {
      return false;
    }
    return bid.priceE6 >= ask.priceE6;
  }

  /** Returns true if neither side has any levels. */
  isEmpty(): boolean {
    return this.#bids.size === 0 && this.#asks.size === 0;
  }

  /**
   * Returns a stable string hash of the top `depth` levels. Two books with
   * the same top-N produce the same hash regardless of insertion order, so
   * downstream tooling can detect snapshot duplicates cheaply.
   */
  hashTopLevels(depth: number): string {
    const top = this.getTopLevels(depth);
    return stableStringify({
      assetId: this.assetId,
      bids: top.bids.map((l) => [l.priceE6.toString(), l.sizeE6.toString()]),
      asks: top.asks.map((l) => [l.priceE6.toString(), l.sizeE6.toString()]),
    });
  }

  #updateLevel(side: "bid" | "ask", priceE6: bigint, sizeE6: bigint): void {
    if (priceE6 < 0n) {
      throw new Error(`Negative price not allowed: ${priceE6}`);
    }
    if (sizeE6 < 0n) {
      throw new Error(`Negative size not allowed: ${sizeE6}`);
    }
    const map = side === "bid" ? this.#bids : this.#asks;
    const key = priceE6.toString();
    if (sizeE6 === 0n) {
      map.delete(key);
    } else {
      map.set(key, sizeE6);
    }
  }
}

function parseTimestamp(value: string | number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function getExtremeBid(bids: ReadonlyMap<string, bigint>): BookLevel | null {
  let best: BookLevel | null = null;
  for (const [priceKey, sizeE6] of bids) {
    const priceE6 = BigInt(priceKey);
    if (!best || priceE6 > best.priceE6) {
      best = { priceE6, sizeE6 };
    }
  }
  return best;
}

function getExtremeAsk(asks: ReadonlyMap<string, bigint>): BookLevel | null {
  let best: BookLevel | null = null;
  for (const [priceKey, sizeE6] of asks) {
    const priceE6 = BigInt(priceKey);
    if (!best || priceE6 < best.priceE6) {
      best = { priceE6, sizeE6 };
    }
  }
  return best;
}

function collectSortedBids(bids: ReadonlyMap<string, bigint>, depth: number): readonly BookLevel[] {
  return [...bids]
    .map(([priceKey, sizeE6]): BookLevel => ({ priceE6: BigInt(priceKey), sizeE6 }))
    .sort((a, b) => (a.priceE6 < b.priceE6 ? 1 : a.priceE6 > b.priceE6 ? -1 : 0))
    .slice(0, depth);
}

function collectSortedAsks(asks: ReadonlyMap<string, bigint>, depth: number): readonly BookLevel[] {
  return [...asks]
    .map(([priceKey, sizeE6]): BookLevel => ({ priceE6: BigInt(priceKey), sizeE6 }))
    .sort((a, b) => (a.priceE6 < b.priceE6 ? -1 : a.priceE6 > b.priceE6 ? 1 : 0))
    .slice(0, depth);
}
