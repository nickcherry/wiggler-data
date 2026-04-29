import type { DatabaseClient } from "@wiggler/lib/db/types";
import {
  blendPrices,
  type CexPriceRegistry,
  type CexPriceState,
} from "@wiggler/lib/prices/state";

type SourceColumns = Readonly<{
  mid_e8: string | null;
  bid_e8: string | null;
  ask_e8: string | null;
  age_ms: string | null;
}>;

function sourceColumns(state: CexPriceState | undefined, capturedAtMs: number): SourceColumns {
  if (!state) {
    return { mid_e8: null, bid_e8: null, ask_e8: null, age_ms: null };
  }
  return {
    mid_e8: state.priceE8 !== null ? state.priceE8.toString() : null,
    bid_e8: state.bidE8 !== null ? state.bidE8.toString() : null,
    ask_e8: state.askE8 !== null ? state.askE8.toString() : null,
    age_ms: (capturedAtMs - state.receivedAtMs).toString(),
  };
}

/**
 * Persists one row in `asset_price_snapshots` for the given symbol using the
 * latest in-memory state of every CEX source. Caller passes the scheduler's
 * `capturedAtMs` so this row's timestamp matches any `book_snapshots` rows
 * written in the same tick (joinable by `captured_at_ms`).
 *
 * Per-source `*_age_ms` columns capture how stale the source's most recent
 * tick was at snapshot time, so analysis can filter out frozen feeds. A
 * source that has never produced a tick contributes nulls across the board.
 */
export async function storeAssetPriceSnapshot(
  db: DatabaseClient,
  args: Readonly<{
    registry: CexPriceRegistry;
    symbol: string;
    capturedAtMs: number;
  }>,
): Promise<void> {
  const { registry, symbol, capturedAtMs } = args;
  const coinbase = registry.get("coinbase", symbol);
  const binance = registry.get("binance", symbol);
  const gemini = registry.get("gemini", symbol);
  const bybit = registry.get("bybit", symbol);
  const bitstamp = registry.get("bitstamp", symbol);
  const bitfinex = registry.get("bitfinex", symbol);
  const kraken = registry.get("kraken", symbol);

  const cb = sourceColumns(coinbase, capturedAtMs);
  const bn = sourceColumns(binance, capturedAtMs);
  const gm = sourceColumns(gemini, capturedAtMs);
  const by = sourceColumns(bybit, capturedAtMs);
  const bs = sourceColumns(bitstamp, capturedAtMs);
  const bf = sourceColumns(bitfinex, capturedAtMs);
  const kr = sourceColumns(kraken, capturedAtMs);

  const blended = blendPrices([
    coinbase?.priceE8 ?? null,
    binance?.priceE8 ?? null,
    gemini?.priceE8 ?? null,
    bybit?.priceE8 ?? null,
    bitstamp?.priceE8 ?? null,
    bitfinex?.priceE8 ?? null,
    kraken?.priceE8 ?? null,
  ]);

  await db
    .insertInto("asset_price_snapshots")
    .values({
      captured_at: new Date(capturedAtMs),
      captured_at_ms: capturedAtMs.toString(),
      symbol,
      coinbase_mid_e8: cb.mid_e8,
      coinbase_bid_e8: cb.bid_e8,
      coinbase_ask_e8: cb.ask_e8,
      coinbase_age_ms: cb.age_ms,
      binance_mid_e8: bn.mid_e8,
      binance_bid_e8: bn.bid_e8,
      binance_ask_e8: bn.ask_e8,
      binance_age_ms: bn.age_ms,
      gemini_mid_e8: gm.mid_e8,
      gemini_bid_e8: gm.bid_e8,
      gemini_ask_e8: gm.ask_e8,
      gemini_age_ms: gm.age_ms,
      bybit_mid_e8: by.mid_e8,
      bybit_bid_e8: by.bid_e8,
      bybit_ask_e8: by.ask_e8,
      bybit_age_ms: by.age_ms,
      bitstamp_mid_e8: bs.mid_e8,
      bitstamp_bid_e8: bs.bid_e8,
      bitstamp_ask_e8: bs.ask_e8,
      bitstamp_age_ms: bs.age_ms,
      bitfinex_mid_e8: bf.mid_e8,
      bitfinex_bid_e8: bf.bid_e8,
      bitfinex_ask_e8: bf.ask_e8,
      bitfinex_age_ms: bf.age_ms,
      kraken_mid_e8: kr.mid_e8,
      kraken_bid_e8: kr.bid_e8,
      kraken_ask_e8: kr.ask_e8,
      kraken_age_ms: kr.age_ms,
      blended_mid_e8: blended.blendedMidE8 !== null ? blended.blendedMidE8.toString() : null,
      source_count: blended.sourceCount,
    })
    .execute();
}
