import { ASSET_PRICE_SCALE } from "@wiggler/constants/markets";

/**
 * Parses a decimal string or number into integer scaled units. Truncates
 * fractional components beyond the scale to avoid floating-point drift.
 */
export function toScaledInt(input: string | number, scale: number): bigint {
  const text = typeof input === "number" ? formatNumber(input) : input.trim();
  if (text === "" || text === "-") {
    throw new Error(`Cannot scale empty value at scale ${scale}.`);
  }

  const negative = text.startsWith("-");
  const body = negative ? text.slice(1) : text;
  const [wholeRaw, fractionRaw = ""] = body.split(".", 2);
  const whole = wholeRaw ?? "0";
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fractionRaw)) {
    throw new Error(`Cannot parse decimal "${input}" at scale ${scale}.`);
  }

  const scaleDigits = Math.log10(scale);
  if (!Number.isInteger(scaleDigits)) {
    throw new Error(`Scale ${scale} is not a power of 10.`);
  }

  const fraction = (fractionRaw + "0".repeat(scaleDigits)).slice(0, scaleDigits);
  const composed = `${whole === "" ? "0" : whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  const value = BigInt(composed);
  return negative ? -value : value;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot scale non-finite number ${value}.`);
  }
  return value.toString();
}

/**
 * Scales an underlying asset price (BTC/USD, ETH/USD, etc.) into 1e8 units.
 * Same helper is reused for OHLCV `open/high/low/close/volume` since 1e8
 * is the canonical precision for every CEX REST response we ingest.
 */
export function assetPriceToE8(input: string | number): bigint {
  return toScaledInt(input, ASSET_PRICE_SCALE);
}

/**
 * Renders an integer scaled value as a decimal string with the given scale.
 */
export function fromScaledInt(value: bigint, scale: number): string {
  const scaleDigits = Math.round(Math.log10(scale));
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const text = abs.toString().padStart(scaleDigits + 1, "0");
  const cut = text.length - scaleDigits;
  const whole = text.slice(0, cut);
  const fraction = text.slice(cut).replace(/0+$/, "");
  const rendered = fraction ? `${whole}.${fraction}` : whole;
  return negative ? `-${rendered}` : rendered;
}
