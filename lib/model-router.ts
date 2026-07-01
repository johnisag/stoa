/**
 * Cost-aware model routing + cascade escalation (#20) — the pure core.
 *
 * Two levers, both deliberately simple and deterministic:
 *   1. ROUTING (cheap base): a dispatch repo may set `default_model` so routine
 *      work runs on an economical tier (e.g. haiku) instead of the agent's
 *      catalog default. The operator is the classifier — no speculative task
 *      heuristics in v1.
 *   2. ESCALATION (climb on failure): when a review/CI fixer round FAILED and a
 *      new fixer is spawned, the new fixer runs ONE tier above the base —
 *      derived purely from the round number (round 1 → base, round ≥2 →
 *      base + 1 tier), so escalation is deterministic per round: no history
 *      column, no double-escalation, and all panelists in a round share a tier.
 *
 * Ladder rules (the safety story):
 *   - Tiers exist ONLY for static-catalog agents (Claude in v1 — Codex's
 *     mini/spark/codex variants don't map to a clean ladder yet). A free-text
 *     agent (hermes/kilo/kimi) is NEVER escalated: its model rides verbatim
 *     into the launch, so the router refuses to invent names for it.
 *   - Every routed/escalated value is a member of the agent's STATIC catalog
 *     (never a synthesized string), and callers still clamp through
 *     resolveModelForAgent + isSafeModel before any spawn — the router adds no
 *     new trust, it only picks among already-trusted values.
 *
 * Pure → unit-tested.
 */

import type { AgentType } from "./providers";
import {
  getModelOptions,
  resolveModelForAgent,
  getDefaultModelForAgent,
} from "./model-catalog";

/**
 * Cheapest → strongest tier WORDS per agent. A catalog model belongs to a tier
 * when its id contains the tier word (so the dated variants — e.g.
 * `claude-haiku-4-5` — land in the same tier as the alias `haiku`). Claude-only
 * in v1; extend when another agent grows an unambiguous ladder.
 */
const MODEL_TIER_LADDER: Partial<Record<AgentType, string[]>> = {
  claude: ["haiku", "sonnet", "opus"],
};

/** The ladder index of `model` for this agent, or null when the agent has no
 *  ladder / the model matches no tier word. */
export function tierIndex(agentType: AgentType, model: string): number | null {
  const ladder = MODEL_TIER_LADDER[agentType];
  if (!ladder) return null;
  const m = model.toLowerCase();
  const idx = ladder.findIndex((tier) => m.includes(tier));
  return idx === -1 ? null : idx;
}

/**
 * The next tier UP from `baseModel` for this agent — a member of the static
 * catalog — or null when there is nothing to climb to (already at the top, no
 * ladder for this agent, or the base doesn't map to a tier). The returned value
 * is the catalog's canonical entry for that tier word (the alias, e.g. "opus").
 */
export function escalateModel(
  agentType: AgentType,
  baseModel: string
): string | null {
  const ladder = MODEL_TIER_LADDER[agentType];
  if (!ladder) return null;
  const idx = tierIndex(agentType, baseModel);
  if (idx == null || idx >= ladder.length - 1) return null;
  const nextTier = ladder[idx + 1];
  // Return the catalog entry for the tier word — never a synthesized name.
  const catalog = getModelOptions(agentType);
  const entry = catalog.find((o) => o.value.toLowerCase() === nextTier);
  return entry ? entry.value : null;
}

/**
 * The model for a FIXER spawn given the repo/agent base model and the 1-based
 * fix round. Round 1 runs the base (the cheap first attempt); round ≥2 —
 * meaning a prior fixer at the base tier already failed to satisfy the panel —
 * climbs exactly ONE tier. Deterministic per round: the same inputs always
 * produce the same model, so re-spawns/crash-recovery can't compound the climb.
 * Falls back to the resolved base whenever escalation isn't possible.
 */
export function modelForFixRound(
  agentType: AgentType,
  baseModel: string | null | undefined,
  round: number
): string {
  const base = resolveModelForAgent(agentType, baseModel ?? undefined);
  const effective = base || getDefaultModelForAgent(agentType);
  if (round <= 1) return effective;
  const escalated = escalateModel(agentType, effective);
  return escalated ?? effective;
}
