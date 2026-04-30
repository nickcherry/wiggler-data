import type { Timeframe } from "@wiggler/constants/candles";
import { TIMEFRAME_MS } from "@wiggler/constants/candles";
import { env } from "@wiggler/constants/env";
import { exchangePair } from "@wiggler/lib/candles/symbols";
import type { Candle, CandleFetcher } from "@wiggler/lib/candles/types";
import { assetPriceToE8 } from "@wiggler/lib/domain/decimal";
import { logger } from "@wiggler/lib/logging/logger";
import { sleep } from "@wiggler/lib/util/sleep";

/**
 * Binance Spot `/api/v3/klines`. We default to Binance.US because
 * Binance.com is geo-blocked from the United States; both expose the
 * exact same endpoint shape under different hosts. Limit is 1000 rows
 * per request, so 1m candles cover ~16h per call.
 *
 * Response: `[[openTime, open, high, low, close, volume, closeTime,
 * quoteVolume, trades, takerBuyBase, takerBuyQuote, ignore], ...]` in
 * ASCENDING order, with all numbers returned as strings.
 *
 * Rate limit: 1200 weight per minute; klines costs 2. We pace at
 * 200ms per request (~5 req/sec) to leave plenty of headroom.
 */
const MAX_CANDLES_PER_REQ = 1000;
const REQUEST_DELAY_MS = 200;

const TIMEFRAME_INTERVAL: Readonly<Record<Timeframe, string>> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
};

export const fetchBinanceCandles: CandleFetcher = async function* ({
  symbol,
  fromMs,
  toMs,
  timeframe,
  signal,
}) {
  const pair = exchangePair("binance", symbol);
  const interval = TIMEFRAME_INTERVAL[timeframe];
  const intervalMs = TIMEFRAME_MS[timeframe];
  const chunkMs = intervalMs * MAX_CANDLES_PER_REQ;

  let cursor = fromMs;
  while (cursor < toMs) {
    if (signal?.aborted) {
      return;
    }
    const chunkEnd = Math.min(cursor + chunkMs, toMs);
    const url = `${env.binanceRestBaseUrl}/api/v3/klines?symbol=${pair}&interval=${interval}&startTime=${cursor}&endTime=${chunkEnd}&limit=${MAX_CANDLES_PER_REQ}`;
    const rows = await fetchJsonWithRetry(url, signal);
    if (!Array.isArray(rows) || rows.length === 0) {
      cursor = chunkEnd + 1;
      await sleep(REQUEST_DELAY_MS, signal);
      continue;
    }

    const candles: Candle[] = [];
    let lastOpen = cursor;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 9) {
        continue;
      }
      const openTimeMs = Number(row[0]);
      const open = String(row[1]);
      const high = String(row[2]);
      const low = String(row[3]);
      const close = String(row[4]);
      const volume = String(row[5]);
      const trades = Number(row[8]);
      candles.push({
        source: "binance",
        symbol,
        exchangePair: pair,
        timeframe,
        openTimeMs,
        openE8: assetPriceToE8(open),
        highE8: assetPriceToE8(high),
        lowE8: assetPriceToE8(low),
        closeE8: assetPriceToE8(close),
        volumeE8: safeVolumeE8(volume),
        tradeCount: Number.isFinite(trades) ? trades : null,
      });
      if (openTimeMs > lastOpen) {
        lastOpen = openTimeMs;
      }
    }
    yield candles;

    // Advance past the last open we saw so we never re-request the same
    // chunk's tail row when the chunk filled to MAX_CANDLES_PER_REQ.
    cursor = lastOpen + intervalMs;
    await sleep(REQUEST_DELAY_MS, signal);
  }
};

function safeVolumeE8(value: string): bigint | null {
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
  if (response.status === 429 || response.status === 418 || response.status >= 500) {
    if (attempt > 5) {
      throw new Error(
        `binance candles failed after ${attempt} attempts: ${response.status}`,
      );
    }
    const backoffMs = Math.min(2 ** attempt * 250, 10_000);
    logger.warn("binance candles backoff", {
      component: "candles_binance",
      status: response.status,
      attempt,
      backoffMs,
    });
    await sleep(backoffMs, signal);
    return fetchJsonWithRetry(url, signal, attempt + 1);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`binance candles ${response.status}: ${body.slice(0, 200)}`);
  }
  return (await response.json());
}
