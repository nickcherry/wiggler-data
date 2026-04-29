import type { PriceSource,PriceTick } from "@wiggler/lib/prices/types";

/**
 * In-memory snapshot of the most recent tick observed from a single CEX
 * source. The price clients update this on every WS frame; the snapshot
 * scheduler reads it once per tick and persists a row.
 *
 * Each `*_e8` field is a BTC-style integer-scaled price (1e8 units). Sizes
 * use the same scale to keep the math uniform; this is approximate for
 * size-in-base-asset values but precise enough for cross-source liveness
 * checks.
 */
export type CexPriceState = Readonly<{
  source: PriceSource;
  symbol: string;
  receivedAtMs: number;
  priceE8: bigint | null;
  bidE8: bigint | null;
  askE8: bigint | null;
}>;

/**
 * Mutable map of `(source, symbol) -> latest CexPriceState`. Owned by the
 * collector coordinator for the lifetime of the run.
 */
export class CexPriceRegistry {
  readonly #states = new Map<string, CexPriceState>();

  static keyOf(source: PriceSource, symbol: string): string {
    return `${source}:${symbol}`;
  }

  /**
   * Records a tick into the registry, replacing any prior state for the
   * same (source, symbol) pair.
   */
  record(tick: PriceTick): void {
    const key = CexPriceRegistry.keyOf(tick.source, tick.symbol);
    this.#states.set(key, {
      source: tick.source,
      symbol: tick.symbol,
      receivedAtMs: tick.receivedAtMs,
      priceE8: tick.priceE8,
      bidE8: tick.bidE8,
      askE8: tick.askE8,
    });
  }

  /**
   * Returns the most recent state for the given source + symbol, or
   * `undefined` if no tick has been seen yet on this run.
   */
  get(source: PriceSource, symbol: string): CexPriceState | undefined {
    return this.#states.get(CexPriceRegistry.keyOf(source, symbol));
  }
}

export type BlendedPrice = Readonly<{
  /** Simple-average midpoint of the live source midpoints. Null if every source is missing. */
  blendedMidE8: bigint | null;
  /** Number of sources that contributed a midpoint. */
  sourceCount: number;
}>;

/**
 * Computes a blended midpoint by averaging the midpoints of each provided
 * source. Sources with `null` midpoints are skipped. Result is null only
 * when no source contributed.
 */
export function blendPrices(midpoints: readonly (bigint | null)[]): BlendedPrice {
  let sum = 0n;
  let count = 0;
  for (const mid of midpoints) {
    if (mid === null) {
      continue;
    }
    sum += mid;
    count += 1;
  }
  if (count === 0) {
    return { blendedMidE8: null, sourceCount: 0 };
  }
  return { blendedMidE8: sum / BigInt(count), sourceCount: count };
}
