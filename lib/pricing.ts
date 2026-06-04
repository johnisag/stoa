/**
 * Approximate per-model token pricing for the session-board cost estimate.
 * Values are USD per MILLION tokens — an ESTIMATE for a glanceable "what is this
 * run costing" signal, NOT billing-grade. Prices move; update them here. Cache
 * write ≈ 1.25× input and cache read ≈ 0.1× input (Anthropic's published
 * multipliers). An unknown model returns null (the UI shows "—").
 */

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const ZERO_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// Matched on the tier word so it works for Stoa's stored values — bare aliases
// ("sonnet"/"opus"/"haiku"), full ids ("claude-sonnet-4-6"), AND Hermes
// free-text ("anthropic/claude-sonnet-4.6"). $/Mtok.
const MODEL_PRICES: Array<{ match: RegExp; price: ModelPrice }> = [
  {
    match: /opus/i,
    price: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  },
  {
    match: /sonnet/i,
    price: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  },
  {
    match: /haiku/i,
    price: { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  },
];

export function priceForModel(
  modelId: string | null | undefined
): ModelPrice | null {
  if (!modelId) return null;
  for (const { match, price } of MODEL_PRICES)
    if (match.test(modelId)) return price;
  return null;
}

/** Total token count (handy for a "1.2M tok" display). */
export function totalTokens(u: TokenUsage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite;
}

/** Estimated USD for a usage tally under a model, or null if the model is unpriced. */
export function computeCostUsd(
  usage: TokenUsage,
  modelId: string | null | undefined
): number | null {
  const p = priceForModel(modelId);
  if (!p) return null;
  return (
    (usage.input * p.input +
      usage.output * p.output +
      usage.cacheRead * p.cacheRead +
      usage.cacheWrite * p.cacheWrite) /
    1_000_000
  );
}
