import type { Timeframe } from "@wiggler/constants/candles";
import { TIMEFRAME_MS } from "@wiggler/constants/candles";
import { env } from "@wiggler/constants/env";
import { exchangePair } from "@wiggler/lib/candles/symbols";
import type { Candle, CandleFetcher } from "@wiggler/lib/candles/types";
import { assetPriceToE8 } from "@wiggler/lib/domain/decimal";
import { logger } from "@wiggler/lib/logging/logger";
import { sleep } from "@wiggler/lib/util/sleep";

/**
 * Coinbase Exchange `GET /products/{pair}/candles?granularity=...`.
 * Limit is 300 candles per request, so 1m candles cover 300 minutes (5h)
 * per call. Response is `[[time, low, high, open, close, volume], ...]`
 * with `time` in unix seconds and rows ordered DESCENDING — we re-sort
 * to ascending for downstream consumers.
 *
 * Rate limit on public endpoints is ~10 req/sec; we pace at ~5 req/sec.
 */
const MAX_CANDLES_PER_REQ = 300;
const REQUEST_DELAY_MS = 200;

const TIMEFRAME_GRANULARITY: Readonly<Record<Timeframe, number | null>> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": null, // Coinbase doesn't natively support 4h; we'd derive it.
  "1d": 86400,
};

export const fetchCoinbaseCandles: CandleFetcher = async function* ({
  symbol,
  fromMs,
  toMs,
  timeframe,
  signal,
}) {
  const granularity = TIMEFRAME_GRANULARITY[timeframe];
  if (granularity === null) {
    throw new Error(`coinbase does not support timeframe ${timeframe}`);
  }
  const pair = exchangePair("coinbase", symbol);
  const intervalMs = TIMEFRAME_MS[timeframe];
  const chunkMs = intervalMs * MAX_CANDLES_PER_REQ;

  let cursor = fromMs;
  while (cursor < toMs) {
    if (signal?.aborted) {
      return;
    }
    // Coinbase's `end` is exclusive in practice. Pull a window slightly
    // larger than `chunkMs` so the last candle's open_time gets included.
    const chunkEnd = Math.min(cursor + chunkMs, toMs);
    const url = `${env.coinbaseRestBaseUrl}/products/${pair}/candles?granularity=${granularity}&start=${new Date(cursor).toISOString()}&end=${new Date(chunkEnd).toISOString()}`;
    const rows = await fetchJsonWithRetry(url, signal);
    if (!Array.isArray(rows) || rows.length === 0) {
      cursor = chunkEnd;
      await sleep(REQUEST_DELAY_MS, signal);
      continue;
    }

    const candles: Candle[] = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 6) {
        continue;
      }
      const [time, low, high, open, close, volume] = row as [
        number,
        number | string,
        number | string,
        number | string,
        number | string,
        number | string,
      ];
      candles.push({
        source: "coinbase",
        symbol,
        exchangePair: pair,
        timeframe,
        openTimeMs: time * 1000,
        openE8: assetPriceToE8(open),
        highE8: assetPriceToE8(high),
        lowE8: assetPriceToE8(low),
        closeE8: assetPriceToE8(close),
        volumeE8: safeVolumeE8(volume),
        tradeCount: null,
      });
    }
    candles.sort((a, b) => a.openTimeMs - b.openTimeMs);
    yield candles;

    cursor = chunkEnd;
    await sleep(REQUEST_DELAY_MS, signal);
  }
};

function safeVolumeE8(value: number | string): bigint | null {
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
        `coinbase candles failed after ${attempt} attempts: ${response.status}`,
      );
    }
    const backoffMs = Math.min(2 ** attempt * 250, 10_000);
    logger.warn("coinbase candles backoff", {
      component: "candles_coinbase",
      status: response.status,
      attempt,
      backoffMs,
    });
    await sleep(backoffMs, signal);
    return fetchJsonWithRetry(url, signal, attempt + 1);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`coinbase candles ${response.status}: ${body.slice(0, 200)}`);
  }
  return (await response.json());
}
