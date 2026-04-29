import { env } from "@wiggler/constants/env";
import { type GammaEvent, gammaEventSchema } from "@wiggler/lib/polymarket/types";

export type GammaFetchResult =
  | { readonly status: "ok"; readonly event: GammaEvent; readonly raw: unknown }
  | { readonly status: "not_found" }
  | { readonly status: "error"; readonly httpStatus: number; readonly body: string };

const DEFAULT_HEADERS: Readonly<Record<string, string>> = {
  Accept: "application/json",
  "User-Agent": "wiggler/0.1 (+polymarket-pulse)",
};

/**
 * Fetches a single Gamma event by slug. Returns a discriminated result so
 * callers can distinguish 404s from real errors.
 */
export async function fetchGammaEventBySlug(
  slug: string,
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<GammaFetchResult> {
  const url = `${env.gammaBaseUrl.replace(/\/$/, "")}/events/slug/${encodeURIComponent(slug)}`;
  const response = await fetch(url, {
    headers: DEFAULT_HEADERS,
    signal: options.signal,
  });

  if (response.status === 404) {
    return { status: "not_found" };
  }
  if (!response.ok) {
    const body = await safeText(response);
    return { status: "error", httpStatus: response.status, body };
  }

  const raw = (await response.json());
  const parsed = gammaEventSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "error",
      httpStatus: response.status,
      body: `Schema mismatch for slug ${slug}: ${parsed.error.message}`,
    };
  }
  return { status: "ok", event: parsed.data, raw };
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable response body>";
  }
}
