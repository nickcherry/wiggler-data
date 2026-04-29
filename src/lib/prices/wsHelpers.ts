import { assetPriceToE8 } from "@wiggler/lib/domain/decimal";
import type WebSocket from "ws";

/**
 * Parses a price/size value (string or number) into an E8 bigint, returning
 * `null` for empty / undefined / unparseable input. Shared across all CEX
 * price-feed clients.
 */
export function parseE8(value: string | number | undefined | null): bigint | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  try {
    return assetPriceToE8(value);
  } catch {
    return null;
  }
}

/**
 * Coerces a Node `ws` `RawData` payload (Buffer, Buffer[], ArrayBuffer, string)
 * to a UTF-8 string for JSON.parse.
 */
export function rawDataToString(data: WebSocket.RawData): string {
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
