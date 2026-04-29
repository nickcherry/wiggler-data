/**
 * Minimal in-memory tracker of bid and ask price levels, used by the price
 * clients whose WS feeds emit incremental L2 updates rather than top-of-book
 * frames (Bitfinex, Kraken). The tracker stores price levels as keys with
 * a boolean "alive" flag — sizes are not retained because midpoint
 * computation only needs the highest bid and lowest ask.
 *
 * `topOfBook()` is O(N) over alive levels; at the depths we subscribe to
 * (10–25 per side) this is well under a microsecond per call.
 *
 * Reset on reconnect: callers should construct a fresh tracker for each new
 * WS session, since the prior book state no longer reflects the exchange.
 */
export class TopOfBookTracker {
  readonly #bids = new Set<bigint>();
  readonly #asks = new Set<bigint>();

  /** Replace the entire book with the supplied snapshot. */
  resetSnapshot(args: {
    bids: readonly bigint[];
    asks: readonly bigint[];
  }): void {
    this.#bids.clear();
    this.#asks.clear();
    for (const p of args.bids) {this.#bids.add(p);}
    for (const p of args.asks) {this.#asks.add(p);}
  }

  setBid(priceE8: bigint): void {
    this.#bids.add(priceE8);
  }
  setAsk(priceE8: bigint): void {
    this.#asks.add(priceE8);
  }
  removeBid(priceE8: bigint): void {
    this.#bids.delete(priceE8);
  }
  removeAsk(priceE8: bigint): void {
    this.#asks.delete(priceE8);
  }

  /**
   * Returns the highest bid and lowest ask currently tracked. Either side
   * is `null` when no level is tracked on that side.
   */
  topOfBook(): { bidE8: bigint | null; askE8: bigint | null } {
    let bid: bigint | null = null;
    for (const p of this.#bids) {
      if (bid === null || p > bid) {bid = p;}
    }
    let ask: bigint | null = null;
    for (const p of this.#asks) {
      if (ask === null || p < ask) {ask = p;}
    }
    return { bidE8: bid, askE8: ask };
  }
}
