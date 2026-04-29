import { z } from "zod";

const numericString = z.union([z.string(), z.number()]);
const sideSchema = z.enum(["BUY", "SELL", "buy", "sell"]);

const sizedLevelSchema = z.object({
  price: numericString,
  size: numericString,
});

/**
 * Polymarket `book` frame. Carries the full top-of-book on connect and on
 * subsequent re-snapshots. Includes `tick_size` and a (best-effort) most-recent
 * `last_trade_price` even though those have their own dedicated event types.
 */
export const wsBookSchema = z.object({
  event_type: z.literal("book"),
  asset_id: z.string(),
  market: z.string().optional(),
  hash: z.string().optional(),
  timestamp: numericString.optional(),
  bids: z.array(sizedLevelSchema).default([]),
  asks: z.array(sizedLevelSchema).default([]),
  tick_size: numericString.optional(),
  last_trade_price: numericString.optional(),
});

/**
 * One entry inside a `price_change` frame. A single frame can carry entries
 * for multiple `asset_id`s — both YES/NO outcomes of a binary market are
 * usually updated together, so the frame is keyed by `market` and each entry
 * specifies which `asset_id` the level update applies to.
 */
export const wsPriceChangeEntrySchema = z.object({
  asset_id: z.string(),
  price: numericString,
  side: sideSchema,
  size: numericString,
  hash: z.string().optional(),
  best_bid: numericString.optional(),
  best_ask: numericString.optional(),
});

export const wsPriceChangeSchema = z.object({
  event_type: z.literal("price_change"),
  market: z.string().optional(),
  timestamp: numericString.optional(),
  price_changes: z.array(wsPriceChangeEntrySchema).default([]),
});

export const wsTickSizeChangeSchema = z.object({
  event_type: z.literal("tick_size_change"),
  asset_id: z.string(),
  market: z.string().optional(),
  old_tick_size: numericString.optional(),
  new_tick_size: numericString,
  timestamp: numericString.optional(),
});

export const wsLastTradePriceSchema = z.object({
  event_type: z.literal("last_trade_price"),
  asset_id: z.string(),
  market: z.string().optional(),
  outcome: z.string().optional(),
  side: sideSchema.optional(),
  price: numericString,
  size: numericString,
  fee_rate_bps: z.union([z.number(), z.string()]).optional(),
  timestamp: numericString.optional(),
});

export const wsAnyEventSchema = z.discriminatedUnion("event_type", [
  wsBookSchema,
  wsPriceChangeSchema,
  wsTickSizeChangeSchema,
  wsLastTradePriceSchema,
]);

export type WsBookEvent = z.infer<typeof wsBookSchema>;
export type WsPriceChangeEntry = z.infer<typeof wsPriceChangeEntrySchema>;
export type WsPriceChangeEvent = z.infer<typeof wsPriceChangeSchema>;
export type WsTickSizeChangeEvent = z.infer<typeof wsTickSizeChangeSchema>;
export type WsLastTradePriceEvent = z.infer<typeof wsLastTradePriceSchema>;
export type WsAnyEvent = z.infer<typeof wsAnyEventSchema>;

/**
 * Per-asset slice of a `price_change` frame, ready to apply to a single
 * `BookState`. Built by `groupPriceChangesByAsset`.
 */
export type PriceChangeSlice = Readonly<{
  market?: string;
  timestamp?: string | number;
  entries: readonly WsPriceChangeEntry[];
}>;

/**
 * Splits a multi-asset `price_change` frame into per-asset slices so each
 * affected `BookState` can apply its own changes independently.
 */
export function groupPriceChangesByAsset(
  event: WsPriceChangeEvent,
): ReadonlyMap<string, PriceChangeSlice> {
  const grouped = new Map<string, WsPriceChangeEntry[]>();
  for (const entry of event.price_changes) {
    const list = grouped.get(entry.asset_id) ?? [];
    list.push(entry);
    grouped.set(entry.asset_id, list);
  }
  const result = new Map<string, PriceChangeSlice>();
  for (const [assetId, entries] of grouped) {
    result.set(assetId, {
      market: event.market,
      timestamp: event.timestamp,
      entries,
    });
  }
  return result;
}

/**
 * Normalizes side values into lowercase.
 */
export function normalizeSide(side: z.infer<typeof sideSchema>): "buy" | "sell" {
  return side.toLowerCase() as "buy" | "sell";
}

/**
 * Best-effort coercion from any unknown WS payload to a typed event. Returns
 * null when the event type is unknown so the raw event can still be persisted.
 */
export function tryParseWsEvent(payload: unknown): WsAnyEvent | null {
  const result = wsAnyEventSchema.safeParse(payload);
  return result.success ? result.data : null;
}
