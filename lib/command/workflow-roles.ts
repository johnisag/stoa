/**
 * Assisted workflow generator — the ROLE layer.
 *
 * The pipeline engine has no concept of a "role": a step's `agent` is a raw
 * provider id (claude/codex/…). The generator deliberately inserts a role
 * abstraction BETWEEN the LLM and the executable spec: the model emits a
 * structural `role` (never an `agent`), and the server maps role → agent here.
 * Keeping the LLM out of provider-name invention means an unknown role is a
 * fail-closed reject rather than a silently-coerced agent, and the role→agent
 * policy is a single auditable constant.
 *
 * The codomain is intentionally restricted to claude | codex (both have static,
 * shell-inert model catalogs). The free-text-model agents (hermes/kilo/kimi)
 * are excluded because their model would ride unescaped into the launch — the
 * model-token-injection class — and a generated step's model is never taken
 * from the LLM anyway. The user can switch any node to any agent in the builder
 * after generation. A unit test asserts every value here stays spawnable.
 */

/**
 * role → executable agent. `satisfies Record<…, "claude" | "codex">` makes the
 * compiler reject any value outside that shell-inert pair. The keys are the role
 * vocabulary the generator prompt teaches and the validator accepts.
 */
export const ROLE_TO_AGENT = {
  researcher: "claude",
  architect: "claude",
  "software-engineer": "codex",
  "ui-ux": "claude",
  tester: "codex",
  integrator: "codex",
  "review-gate": "claude",
} as const satisfies Record<string, "claude" | "codex">;

export type WorkflowRole = keyof typeof ROLE_TO_AGENT;

/** The role vocabulary, in canonical pipeline order (roots → sink). */
export const WORKFLOW_ROLES = Object.keys(ROLE_TO_AGENT) as WorkflowRole[];

/** Narrow an arbitrary value to a known role (membership test — not `in`, which
 * would also match inherited Object.prototype keys like "toString"). */
export function isWorkflowRole(v: unknown): v is WorkflowRole {
  return typeof v === "string" && (WORKFLOW_ROLES as string[]).includes(v);
}

/** One-line description of each role + how many nodes it typically gets, used to
 * teach the generator prompt the canonical fleet. */
export const ROLE_GUIDANCE: Record<WorkflowRole, string> = {
  researcher:
    "investigates the problem space (codebase, docs, prior art) and writes findings. ~3 roots, each on a distinct angle, run in parallel.",
  architect:
    "designs the solution from the research. Typically two: one for overall ARCHITECTURE, one for the COMPONENT/module breakdown. Depend on the researchers.",
  "software-engineer":
    "implements the code. ~3, ideally on file-disjoint slices so they can run in parallel. Depend on the architects.",
  "ui-ux": "designs and implements the UI/UX. ~2. Depend on the architects.",
  tester:
    "develops the full test suite (unit + integration). ~2. Depend on the engineers and ui/ux work.",
  integrator:
    "integrates every slice into one coherent, working whole and resolves conflicts. 1. Depends on the engineers, ui/ux, and testers.",
  "review-gate":
    "the final review + sign-off: judges the whole result on correctness/security, conventions/cross-platform, and simplicity/UX, and only signs off if all three pass. Exactly ONE, the sink — depends on the integrator (and anything not already upstream of it).",
};

/** Hard ceiling on generated steps — keeps a crafted/runaway reply from bloating
 * the canvas and the saved-workflow DB row. A scaled fleet is ~13–25 nodes. */
export const MAX_GENERATED_STEPS = 40;
