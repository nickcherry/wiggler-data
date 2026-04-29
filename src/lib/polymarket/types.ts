import { z } from "zod";

/**
 * Subset of Polymarket Gamma `event` shape used by Polymarket Pulse. Unknown
 * fields are preserved verbatim under `raw` for storage and audit.
 */
export const gammaTokenSchema = z.object({
  token_id: z.string().optional(),
  outcome: z.string().optional(),
  price: z.union([z.number(), z.string()]).optional(),
});

export const gammaMarketSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  question: z.string().optional(),
  conditionId: z.string().optional(),
  condition_id: z.string().optional(),
  slug: z.string().optional(),
  active: z.boolean().optional(),
  closed: z.boolean().optional(),
  archived: z.boolean().optional(),
  resolutionSource: z.string().optional(),
  resolution_source: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  startDateIso: z.string().optional(),
  endDateIso: z.string().optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  outcomes: z.union([z.string(), z.array(z.string())]).optional(),
  outcomePrices: z.union([z.string(), z.array(z.string())]).optional(),
  clobTokenIds: z.union([z.string(), z.array(z.string())]).optional(),
  tokens: z.array(gammaTokenSchema).optional(),
  resolved: z.boolean().optional(),
  umaResolutionStatus: z.string().optional(),
});

export const gammaEventSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  slug: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  active: z.boolean().optional(),
  closed: z.boolean().optional(),
  archived: z.boolean().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  markets: z.array(gammaMarketSchema).optional(),
});

export type GammaEvent = z.infer<typeof gammaEventSchema>;
export type GammaMarket = z.infer<typeof gammaMarketSchema>;
export type GammaToken = z.infer<typeof gammaTokenSchema>;

export type ParsedMarket = Readonly<{
  assetSymbol: string;
  slug: string;
  eventId: string | null;
  marketId: string | null;
  conditionId: string | null;
  question: string | null;
  title: string | null;
  startMs: number;
  endMs: number;
  upTokenId: string | null;
  downTokenId: string | null;
  resolutionSource: string | null;
  active: boolean | null;
  closed: boolean | null;
  archived: boolean | null;
  resolved: boolean;
  resolvedOutcome: string | null;
  rawGamma: unknown;
}>;
