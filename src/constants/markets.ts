/**
 * Asset prices (BTC/USD, ETH/USD, etc.) are stored as integer 1e8 units to
 * keep precision exact across the lossy edges of CEX REST responses.
 */
export const ASSET_PRICE_SCALE = 100_000_000;

/**
 * Volumes are stored at 1e8 to preserve sub-satoshi precision in base-asset
 * units. (No exchange we ingest reports finer than 8 decimal places.)
 */
export const VOLUME_SCALE = 100_000_000;
