import type { Timeframe } from "@wiggler/constants/candles";
import { TIMEFRAME_MS } from "@wiggler/constants/candles";
import { env } from "@wiggler/constants/env";
import { exchangePair } from "@wiggler/lib/candles/symbols";
import type { Candle, CandleFetcher } from "@wiggler/lib/candles/types";
import { assetPriceToE8 } from "@wiggler/lib/domain/decimal";
import { logger } from "@wiggler/lib/logging/logger";
import { sleep } from "@wiggler/lib/util/sleep";

/**
 * Bitstamp `GET /api/v2/ohlc/{pair}/`. `step` is interval seconds; `start`
 * and `end` are unix seconds; `limit` is up to 1000. Response wraps rows
 * under `data.ohlc` with each row keyed by its named field; values are
 * strings.
 *
 * **API quirk:** the Bitstamp endpoint anchors on `end` and `limit` more
 * than `start`. If you request `(start=A, end=B, limit=1000)` and the
 * window `[A, B]` only contains 30 candles, Bitstamp will return 1000
 * candles ENDING at `B` — i.e. it'll happily return data from before
 * `start` to fill the limit. We work around this by:
 *
 *   1. Clamping `limit` to the number of candles that should fit in the
 *      window so we don't ask for more than we want, and
 *   2. Filtering the response to `[fromMs, toMs]` defensively in case the
 *      server still ranges outside the requested window.
 *
 * Rate limit: 8000 requests / 10 minutes ≈ 13 req/sec. We pace at
 * 200ms per request (~5 req/sec).
 */
const MAX_CANDLES_PER_REQ = 1000;
const REQUEST_DELAY_MS = 200;

const TIMEFRAME_STEP_SEC: Readonly<Record<Timeframe, number | null>> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

type BitstampOhlcRow = Readonly<{
  timestamp: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}>;

type BitstampOhlcResponse = Readonly<{
  data: { pair: string; ohlc: readonly BitstampOhlcRow[] };
}>;

export const fetchBitstampCandles: CandleFetcher = async function* ({
  symbol,
  fromMs,
  toMs,
  timeframe,
  signal,
}) {
  const step = TIMEFRAME_STEP_SEC[timeframe];
  if (step === null) {
    throw new Error(`bitstamp does not support timeframe ${timeframe}`);
  }
  const pair = exchangePair("bitstamp", symbol);
  const intervalMs = TIMEFRAME_MS[timeframe];
  const chunkMs = intervalMs * MAX_CANDLES_PER_REQ;

  let cursor = fromMs;
  while (cursor < toMs) {
    if (signal?.aborted) {
      return;
    }
    const chunkEnd = Math.min(cursor + chunkMs, toMs);
    const startSec = Math.floor(cursor / 1000);
    const endSec = Math.floor(chunkEnd / 1000);
    // Clamp limit to the candles that actually fit in this chunk's
    // window. Without this, asking for `limit=1000` on a 30-minute
    // window made Bitstamp return 1000 candles anchored at `end`,
    // including ~16 hours of data BEFORE our requested `start`.
    const expectedCandles = Math.max(
      1,
      Math.min(MAX_CANDLES_PER_REQ, Math.ceil((chunkEnd - cursor) / intervalMs)),
    );
    const url = `${env.bitstampRestBaseUrl}/api/v2/ohlc/${pair}/?step=${step}&limit=${expectedCandles}&start=${startSec}&end=${endSec}`;
    const payload = await fetchJsonWithRetry(url, signal);
    const rows = extractRows(payload);

    if (rows.length === 0) {
      cursor = chunkEnd + 1;
      await sleep(REQUEST_DELAY_MS, signal);
      continue;
    }

    const candles: Candle[] = [];
    let lastOpen = cursor;
    for (const row of rows) {
      const openTimeMs = Number(row.timestamp) * 1000;
      if (!Number.isFinite(openTimeMs)) {
        continue;
      }
      // Defensive bounds check: reject any rows the server returned
      // outside our requested window. Cheap insurance against the
      // anchor-on-end quirk above.
      if (openTimeMs < cursor || openTimeMs >= chunkEnd) {
        continue;
      }
      candles.push({
        source: "bitstamp",
        symbol,
        exchangePair: pair,
        timeframe,
        openTimeMs,
        openE8: assetPriceToE8(row.open),
        highE8: assetPriceToE8(row.high),
        lowE8: assetPriceToE8(row.low),
        closeE8: assetPriceToE8(row.close),
        volumeE8: safeVolumeE8(row.volume),
        tradeCount: null,
      });
      if (openTimeMs > lastOpen) {
        lastOpen = openTimeMs;
      }
    }
    yield candles;
    // If the server returned no in-window rows, advance past the chunk
    // entirely so we don't loop forever on an unusable response.
    cursor = lastOpen > cursor ? lastOpen + intervalMs : chunkEnd;
    await sleep(REQUEST_DELAY_MS, signal);
  }
};

function extractRows(payload: unknown): readonly BitstampOhlcRow[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const data = (payload as BitstampOhlcResponse).data;
  if (!data || !Array.isArray(data.ohlc)) {
    return [];
  }
  return data.ohlc;
}

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
  if (response.status === 429 || response.status >= 500) {
    if (attempt > 5) {
      throw new Error(
        `bitstamp candles failed after ${attempt} attempts: ${response.status}`,
      );
    }
    const backoffMs = Math.min(2 ** attempt * 250, 10_000);
    logger.warn("bitstamp candles backoff", {
      component: "candles_bitstamp",
      status: response.status,
      attempt,
      backoffMs,
    });
    await sleep(backoffMs, signal);
    return fetchJsonWithRetry(url, signal, attempt + 1);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`bitstamp candles ${response.status}: ${body.slice(0, 200)}`);
  }
  return (await response.json());
}
