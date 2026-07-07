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

interface TokenRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface ModelPrice extends TokenRates {
  longContext?: TokenRates;
}

export interface CostOptions {
  longContext?: boolean;
}

// Matched on the tier word so it works for Stoa's stored values — bare aliases
// ("sonnet"/"opus"/"haiku"), full ids ("claude-sonnet-4-6"), AND Hermes
// free-text ("anthropic/claude-sonnet-4.6"). $/Mtok.
const MODEL_PRICES: Array<{ match: RegExp; price: ModelPrice }> = [
  {
    match: /\bgpt-5\.5\b/i,
    price: {
      input: 5,
      output: 30,
      cacheWrite: 5,
      cacheRead: 0.5,
      longContext: { input: 10, output: 45, cacheWrite: 10, cacheRead: 1 },
    },
  },
  {
    match: /\bgpt-5\.4-mini\b/i,
    price: { input: 0.75, output: 4.5, cacheWrite: 0.75, cacheRead: 0.075 },
  },
  {
    match: /\bgpt-5\.4-nano\b/i,
    price: { input: 0.2, output: 1.25, cacheWrite: 0.2, cacheRead: 0.02 },
  },
  {
    match: /\bgpt-5\.4\b/i,
    price: {
      input: 2.5,
      output: 15,
      cacheWrite: 2.5,
      cacheRead: 0.25,
      longContext: { input: 5, output: 22.5, cacheWrite: 5, cacheRead: 0.5 },
    },
  },
  {
    match: /\bgpt-5(?:\.3)?-codex(?:-spark)?\b/i,
    price: { input: 1.75, output: 14, cacheWrite: 1.75, cacheRead: 0.175 },
  },
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
  modelId: string | null | undefined,
  options: CostOptions = {}
): TokenRates | null {
  if (!modelId) return null;
  for (const { match, price } of MODEL_PRICES) {
    if (match.test(modelId)) {
      return options.longContext && price.longContext
        ? price.longContext
        : price;
    }
  }
  return null;
}

/** Total token count (handy for a "1.2M tok" display). */
export function totalTokens(u: TokenUsage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite;
}

/** Estimated USD for a usage tally under a model, or null if the model is unpriced. */
export function computeCostUsd(
  usage: TokenUsage,
  modelId: string | null | undefined,
  options: CostOptions = {}
): number | null {
  const p = priceForModel(modelId, options);
  if (!p) return null;
  return (
    (usage.input * p.input +
      usage.output * p.output +
      usage.cacheRead * p.cacheRead +
      usage.cacheWrite * p.cacheWrite) /
    1_000_000
  );
}

/**
 * Prompt-cache hit rate (#12): the fraction of INPUT-side tokens served from the
 * cache — `cacheRead / (input + cacheRead + cacheWrite)`, in 0..1, or null when the
 * model processed no input yet. High = most of the re-sent context was a cheap
 * ~0.1× cache read rather than a full-price fresh read. Pure → unit-tested.
 */
export function cacheHitRate(u: TokenUsage): number | null {
  const inputSide = u.input + u.cacheRead + u.cacheWrite;
  return inputSide > 0 ? u.cacheRead / inputSide : null;
}

/**
 * Estimated USD SAVED by the prompt cache vs. paying full input price for the same
 * tokens: `cacheRead × (input − cacheRead) $/Mtok`. Null when the model is unpriced.
 * A concrete "the cache is earning its keep" figure. Pure → unit-tested.
 */
export function cacheSavingsUsd(
  u: TokenUsage,
  modelId: string | null | undefined,
  options: CostOptions = {}
): number | null {
  const p = priceForModel(modelId, options);
  if (!p) return null;
  return (u.cacheRead * (p.input - p.cacheRead)) / 1_000_000;
}
