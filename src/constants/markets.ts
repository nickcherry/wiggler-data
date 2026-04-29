/**
 * Length of a single Polymarket Up/Down market window in milliseconds.
 */
export const FIVE_MINUTE_MS = 5 * 60 * 1000;

/**
 * Default top-of-book depth captured for each book snapshot.
 */
export const DEFAULT_BOOK_DEPTH = 20;

/**
 * Probability prices are scaled to integer microunits (1e6).
 */
export const PRICE_SCALE = 1_000_000;

/**
 * Share sizes are scaled to integer microunits (1e6).
 */
export const SIZE_SCALE = 1_000_000;

/**
 * Underlying asset prices (BTC/USD, ETH/USD, etc.) are scaled to 1e8 integer
 * units to keep precision exact. Used for the `asset_price_snapshots` table.
 */
export const ASSET_PRICE_SCALE = 100_000_000;

/**
 * Slug suffix for the recurring 5-minute Up/Down markets. The full slug is
 * `<asset>-updown-5m-<unix_start_seconds>` (e.g. `btc-updown-5m-1777475700`).
 */
export const UPDOWN_5M_SLUG_INFIX = "updown-5m";
