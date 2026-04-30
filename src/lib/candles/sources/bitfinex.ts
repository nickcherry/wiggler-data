import type { Timeframe } from "@wiggler/constants/candles";
import { TIMEFRAME_MS } from "@wiggler/constants/candles";
import { env } from "@wiggler/constants/env";
import { exchangePair } from "@wiggler/lib/candles/symbols";
import type { Candle, CandleFetcher } from "@wiggler/lib/candles/types";
import { assetPriceToE8 } from "@wiggler/lib/domain/decimal";
import { logger } from "@wiggler/lib/logging/logger";
import { sleep } from "@wiggler/lib/util/sleep";

/**
 * Bitfinex `GET /v2/candles/trade:{TF}:{SYMBOL}/hist`. Note the column
 * order: `[mts, open, close, high, low, volume]` — `close` and `high`
 * come BEFORE `low`, which is different from every other source. Limit
 * is 10000 candles per request, which is huge — 1m candles cover ~7
 * days per call. Default sort is descending; we re-sort to ascending.
 *
 * Rate limit: ~90 req/min for this specific endpoint. We pace at
 * 1.5s per request (~40 req/min) to leave headroom.
 */
const MAX_CANDLES_PER_REQ = 10_000;
const REQUEST_DELAY_MS = 1500;

const TIMEFRAME_STR: Readonly<Record<Timeframe, string>> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1D",
};

export const fetchBitfinexCandles: CandleFetcher = async function* ({
  symbol,
  fromMs,
  toMs,
  timeframe,
  signal,
}) {
  const tf = TIMEFRAME_STR[timeframe];
  const pair = exchangePair("bitfinex", symbol);
  const intervalMs = TIMEFRAME_MS[timeframe];
  const chunkMs = intervalMs * MAX_CANDLES_PER_REQ;

  let cursor = fromMs;
  while (cursor < toMs) {
    if (signal?.aborted) {
      return;
    }
    const chunkEnd = Math.min(cursor + chunkMs, toMs);
    const url = `${env.bitfinexRestBaseUrl}/v2/candles/trade:${tf}:${pair}/hist?start=${cursor}&end=${chunkEnd}&limit=${MAX_CANDLES_PER_REQ}&sort=1`;
    const rows = await fetchJsonWithRetry(url, signal);

    if (!Array.isArray(rows) || rows.length === 0) {
      cursor = chunkEnd + 1;
      await sleep(REQUEST_DELAY_MS, signal);
      continue;
    }

    const candles: Candle[] = [];
    let lastOpen = cursor;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 6) {
        continue;
      }
      // Bitfinex order: mts, open, close, high, low, volume.
      const [mts, open, close, high, low, volume] = row as [
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      candles.push({
        source: "bitfinex",
        symbol,
        exchangePair: pair,
        timeframe,
        openTimeMs: mts,
        openE8: assetPriceToE8(open),
        highE8: assetPriceToE8(high),
        lowE8: assetPriceToE8(low),
        closeE8: assetPriceToE8(close),
        volumeE8: safeVolumeE8(volume),
        tradeCount: null,
      });
      if (mts > lastOpen) {
        lastOpen = mts;
      }
    }
    yield candles;
    cursor = lastOpen + intervalMs;
    await sleep(REQUEST_DELAY_MS, signal);
  }
};

function safeVolumeE8(value: number): bigint | null {
  try {
    return assetPriceToE8(value);
  } catch {
    return null;
  }
}

async function fetchJsonWithRetry(
  url: string,
  signal: AbortSignal | undefined,
  attempt = 1,
): Promise<unknown> {
  const response = await fetch(url, { signal });
  if (response.status === 429 || response.status >= 500) {
    if (attempt > 5) {
      throw new Error(
        `bitfinex candles failed after ${attempt} attempts: ${response.status}`,
      );
    }
    const backoffMs = Math.min(2 ** attempt * 500, 30_000);
    logger.warn("bitfinex candles backoff", {
      component: "candles_bitfinex",
      status: response.status,
      attempt,
      backoffMs,
    });
    await sleep(backoffMs, signal);
    return fetchJsonWithRetry(url, signal, attempt + 1);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`bitfinex candles ${response.status}: ${body.slice(0, 200)}`);
  }
  return (await response.json());
}
