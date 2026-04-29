import { PRICE_SCALE } from "@wiggler/constants/markets";

export type BookSummary = Readonly<{
  bestBidE6: bigint | null;
  bestAskE6: bigint | null;
  spreadE6: bigint | null;
}>;

export type ComplementCheck = Readonly<{
  ok: boolean;
  detail: string;
}>;

/**
 * Sanity-checks an Up/Down market by comparing the best bids/asks of the two
 * outcomes. Up_ask + Down_ask should be >= 1, Up_bid + Down_bid should be <= 1.
 */
export function checkComplementPrices(args: {
  up: BookSummary;
  down: BookSummary;
}): ComplementCheck {
  if (
    !args.up.bestBidE6 ||
    !args.up.bestAskE6 ||
    !args.down.bestBidE6 ||
    !args.down.bestAskE6
  ) {
    return { ok: true, detail: "incomplete books" };
  }
  const askSum = args.up.bestAskE6 + args.down.bestAskE6;
  const bidSum = args.up.bestBidE6 + args.down.bestBidE6;
  const askOk = askSum + BigInt(PRICE_SCALE / 100) >= BigInt(PRICE_SCALE); // tolerate 1c slack
  const bidOk = bidSum <= BigInt(PRICE_SCALE) + BigInt(PRICE_SCALE / 100);
  if (askOk && bidOk) {
    return { ok: true, detail: "complement check passed" };
  }
  return {
    ok: false,
    detail: `ask_sum=${askSum.toString()} bid_sum=${bidSum.toString()} (e6 units)`,
  };
}

export type CrossedCheck = Readonly<{
  crossed: boolean;
  detail: string;
}>;

/**
 * Returns whether the book is crossed (best bid >= best ask) and a debug detail.
 */
export function checkCrossed(book: BookSummary): CrossedCheck {
  if (!book.bestBidE6 || !book.bestAskE6) {
    return { crossed: false, detail: "no two-sided book" };
  }
  return {
    crossed: book.bestBidE6 >= book.bestAskE6,
    detail: `best_bid=${book.bestBidE6.toString()} best_ask=${book.bestAskE6.toString()}`,
  };
}
