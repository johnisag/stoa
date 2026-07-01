/**
 * Per-session cost budgets with alerts + opt-in fail-closed park (#21).
 *
 * A session may carry a lifetime USD budget (`sessions.budget_usd`, set in the
 * New Session dialog's advanced settings). The 30s budget tick evaluates each
 * budgeted session's live cost against it:
 *   - crossing 80%  → ONE push alert ("budget warning");
 *   - crossing 100% → ONE push alert — and, when STOA_BUDGET_PARK=1 (opt-in,
 *     default OFF), the session is PARKED.
 *
 * PARK is fail-closed but PASSIVE — the mirror of the rate-limit park: Stoa
 * stops FEEDING the session work (the prompt queue, the rate-limit auto-resume
 * nudge, and channel delivery all skip a parked session), but nothing is killed
 * and the user can still type into the terminal — a deliberate human override.
 * Unpark by raising/clearing the budget (the tick clears the park when the
 * session drops back under its cap) or deleting the session. This differs from
 * the GLOBAL hard-cap enforcement (STOA_BUDGET_HARD_USD kills); both can be
 * armed — the kill is final, the park is the softer per-session layer.
 *
 * Stage detection is edge-triggered (mirrors lib/budget.ts detectBudgetBreaches):
 * alerts fire only when a session ESCALATES into a stage, never repeatedly while
 * it sits there. The carried stage is a RATCHET keyed on the budget it was
 * computed against: with an unchanged budget a stage never moves down — cost is
 * append-only in practice, so a transient under-read (a cache hiccup, a /compact
 * truncation, a missing read this tick) must not unpark a capped session or
 * re-arm its alert edges into a push-spam loop. Changing the budget re-bases
 * the ratchet fresh, which is exactly the legitimate unpark path. Pure
 * decisions → unit-tested; the in-memory park/stage state lives here so every
 * consumer (ticks, status route) reads one source. The state does not survive a
 * restart — the tick runs once at startup to re-park within seconds (durable
 * persistence is the v2 follow-up).
 */

import type { Session } from "./db";

export type BudgetStage = "ok" | "warn80" | "cap";

/** A carried stage + the budget it was computed against (the ratchet key). */
export interface CarriedStage {
  stage: BudgetStage;
  budgetUsd: number;
}

/** Opt-in gate for the park action (alerts fire regardless of this). */
export function budgetParkEnabled(): boolean {
  return process.env.STOA_BUDGET_PARK === "1";
}

/** The stage for a session's live cost vs its budget. Null/absent budget or
 *  cost (an unpriced agent, a just-spawned session) → "ok" — a budget can only
 *  ever restrict a session whose spend is actually known. Pure. */
export function stageForBudget(
  costUsd: number | null | undefined,
  budgetUsd: number | null | undefined
): BudgetStage {
  if (
    budgetUsd == null ||
    !Number.isFinite(budgetUsd) ||
    budgetUsd <= 0 ||
    costUsd == null ||
    !Number.isFinite(costUsd)
  ) {
    return "ok";
  }
  if (costUsd >= budgetUsd) return "cap";
  if (costUsd >= budgetUsd * 0.8) return "warn80";
  return "ok";
}

const STAGE_RANK: Record<BudgetStage, number> = { ok: 0, warn80: 1, cap: 2 };

export interface BudgetDecision {
  /** Sessions that just ESCALATED into warn80 (one alert each). */
  alert80: Array<{
    id: string;
    name: string;
    costUsd: number;
    budgetUsd: number;
  }>;
  /** Sessions that just ESCALATED into cap (one alert each). */
  alert100: Array<{
    id: string;
    name: string;
    costUsd: number;
    budgetUsd: number;
  }>;
  /** Sessions to PARK now (subset of alert100 when the opt-in is armed and the
   *  session isn't already parked). */
  park: string[];
  /** Sessions to UNPARK (previously parked, now back under their cap — a raised
   *  or cleared budget). */
  unpark: string[];
  /** The stages to carry into the next tick. */
  nextStages: Map<string, CarriedStage>;
}

/**
 * The per-tick decision over the WHOLE fleet (pass every session, not just the
 * budgeted ones — a parked session whose budget was CLEARED must flow through
 * here to be unparked). Edge-triggered on stage ESCALATION (ok→warn80, ok→cap,
 * warn80→cap); the budget-keyed ratchet means de-escalation only happens when
 * the budget itself changed, so cost noise can neither unpark nor re-alert.
 * Pure — the caller supplies parked membership and applies the actions.
 */
export function decideBudgetActions(input: {
  sessions: Array<Pick<Session, "id" | "name" | "budget_usd">>;
  costs: Record<string, { costUsd: number | null } | undefined>;
  prevStages: Map<string, CarriedStage>;
  parked: ReadonlySet<string>;
  parkEnabled: boolean;
}): BudgetDecision {
  const out: BudgetDecision = {
    alert80: [],
    alert100: [],
    park: [],
    unpark: [],
    nextStages: new Map(),
  };
  for (const s of input.sessions) {
    const budgetUsd = s.budget_usd ?? null;
    const costUsd = input.costs[s.id]?.costUsd ?? null;
    const prev = input.prevStages.get(s.id);
    const raw = stageForBudget(costUsd, budgetUsd);
    // The ratchet: same budget → stage only moves up; changed budget → re-base.
    const sameBudget = prev !== undefined && prev.budgetUsd === budgetUsd;
    const stage =
      sameBudget && STAGE_RANK[prev.stage] > STAGE_RANK[raw] ? prev.stage : raw;
    if (stage !== "ok" && budgetUsd != null) {
      out.nextStages.set(s.id, { stage, budgetUsd });
    }
    const prevStage = prev?.stage ?? "ok";
    const escalated = STAGE_RANK[stage] > STAGE_RANK[prevStage];
    if (escalated && budgetUsd != null && costUsd != null) {
      const entry = { id: s.id, name: s.name, costUsd, budgetUsd };
      if (stage === "warn80") out.alert80.push(entry);
      if (stage === "cap") out.alert100.push(entry);
    }
    if (stage === "cap" && input.parkEnabled && !input.parked.has(s.id)) {
      out.park.push(s.id);
    }
    if (stage !== "cap" && input.parked.has(s.id)) {
      out.unpark.push(s.id); // budget raised/cleared → back to work
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared in-memory state (single-process; the tick writes, consumers read).
// ---------------------------------------------------------------------------

const parkedSessions = new Set<string>();
let budgetStages = new Map<string, CarriedStage>();

/** Whether the tick parked this session at its budget cap. The work-feeding
 *  paths (prompt queue, rate-limit auto-resume, channel delivery) must skip a
 *  parked session — that's the fail-closed half of the park. */
export function isBudgetParked(id: string): boolean {
  return parkedSessions.has(id);
}

/** The session's current budget stage (for the status route / UI badge). */
export function getBudgetStage(id: string): BudgetStage {
  return budgetStages.get(id)?.stage ?? "ok";
}

/** Applied by the budget tick after decideBudgetActions. */
export function applyBudgetDecision(d: BudgetDecision): void {
  for (const id of d.park) parkedSessions.add(id);
  for (const id of d.unpark) parkedSessions.delete(id);
  budgetStages = d.nextStages;
}

/** Snapshot for the next tick's edge detection. */
export function currentBudgetStages(): Map<string, CarriedStage> {
  return budgetStages;
}

/** Current parked membership (read-only view for the decision input). */
export function currentParked(): ReadonlySet<string> {
  return parkedSessions;
}

/** Drop state for sessions that no longer exist (called with live ids). */
export function pruneBudgetState(liveIds: ReadonlySet<string>): void {
  for (const id of parkedSessions) {
    if (!liveIds.has(id)) parkedSessions.delete(id);
  }
  for (const id of budgetStages.keys()) {
    if (!liveIds.has(id)) budgetStages.delete(id);
  }
}

/** Test-only: reset module state. */
export function _resetBudgetParkState(): void {
  parkedSessions.clear();
  budgetStages = new Map();
}
