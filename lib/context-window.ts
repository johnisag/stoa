/**
 * Approximate per-model context-window caps + a pure gauge helper for the live
 * "how full is the agent's context" badge. Caps are an ESTIMATE for a
 * glanceable signal (silent context exhaustion is otherwise invisible), NOT an
 * authoritative limit — providers move them and prompt-caching/overhead make the
 * real ceiling fuzzy. Pure (no node builtins) so it's safe to import in a client
 * component; mirrors lib/pricing.ts's match-on-tier-word approach.
 */

/** Fallback cap when the model is unknown/unpriced — a conservative 200k. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Effective input budget Codex CLI reports for current GPT-5.x Codex sessions. */
export const CODEX_CONTEXT_WINDOW = 258_400;

// Matched on the tier word so it works for Stoa's stored values — bare aliases
// ("sonnet"/"opus"/"haiku"), full ids ("claude-sonnet-4-6"), AND Hermes
// free-text ("anthropic/claude-sonnet-4.6"). Tokens.
const CONTEXT_WINDOWS: Array<{ match: RegExp; window: number }> = [
  { match: /\bgpt-5\.5\b/i, window: CODEX_CONTEXT_WINDOW },
  {
    match: /\bgpt-5(?:\.\d+)?-codex(?:-spark)?\b/i,
    window: CODEX_CONTEXT_WINDOW,
  },
  // Sonnet's 1M-token beta is opt-in; the default surface is 200k like the rest.
  { match: /opus/i, window: 200_000 },
  { match: /sonnet/i, window: 200_000 },
  { match: /haiku/i, window: 200_000 },
];

/** Approximate context-window size (tokens) for a model, or the default cap. */
export function contextWindowFor(modelId: string | null | undefined): number {
  if (!modelId) return DEFAULT_CONTEXT_WINDOW;
  for (const { match, window } of CONTEXT_WINDOWS)
    if (match.test(modelId)) return window;
  return DEFAULT_CONTEXT_WINDOW;
}

export type ContextTone = "ok" | "warn" | "full";

export interface ContextMeter {
  /** Fraction of the window in use, clamped to 0..1. */
  pct: number;
  /** Tint band: muted under 70%, amber 70–90%, red at/over 90%. */
  tone: ContextTone;
}

/** Amber once the window is this full; red at the next threshold. */
const WARN_AT = 0.7;
const FULL_AT = 0.9;

/**
 * Map a live token count against a context window to a clamped fraction + a tone
 * band for tinting. Pure → unit-testable. A non-positive window yields a full
 * gauge rather than dividing by zero (treat "no known cap" as already maxed so
 * the badge errs visible, not silently empty).
 */
export function tokenMeter(
  tokens: number,
  contextWindow: number
): ContextMeter {
  const safeTokens = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  if (!(contextWindow > 0)) return { pct: 1, tone: "full" };
  const pct = Math.min(1, safeTokens / contextWindow);
  const tone: ContextTone =
    pct >= FULL_AT ? "full" : pct >= WARN_AT ? "warn" : "ok";
  return { pct, tone };
}
