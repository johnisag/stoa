/**
 * Command Stoa — the fail-closed ALLOWLIST of actions the chatbox may perform.
 *
 * This is the security spine of Phase 2 ("the chatbox acts"). The agent only ever
 * PROPOSES a structured action; this module is the single source of truth that
 * decides whether a proposal is a known-safe SHAPE. It is a fail-CLOSED allowlist,
 * not a denylist: only an explicitly-listed action with params that pass its
 * per-action validator survives — everything else is rejected with a reason.
 *
 * It runs in BOTH directions of defense-in-depth:
 *   - /api/command/propose validates the agent's proposal before showing a card.
 *   - /api/command/execute RE-VALIDATES the (client-supplied) action before doing
 *     anything — the client is never trusted.
 *
 * Pure by construction: no DB, no fs, no spawn — just shape validation against
 * known catalogs (providers, models). The one inherently-stateful check (does the
 * chosen projectId exist?) is deliberately left to the caller, which resolves the
 * project from the DB and derives the working directory SERVER-SIDE — the agent
 * never supplies a filesystem path. Unit-tested as the allowlist regression guard.
 */

import { getProviderDefinition } from "@/lib/providers/registry";
import { getModelOptions } from "@/lib/model-catalog";
import { validateSpec } from "@/lib/pipeline/engine";
import { docFromSpec, type BuilderDoc } from "@/lib/pipeline/builder-model";
import type { PipelineSpec, PipelineStep } from "@/lib/pipeline/types";
import {
  ROLE_TO_AGENT,
  isWorkflowRole,
  MAX_GENERATED_STEPS,
} from "@/lib/command/workflow-roles";

/** The actions Command Stoa can perform. Phase 2 ships create_session; extended
 * with dispatch_issue (local task creation), open_view (client-side navigation),
 * list_sessions (read-only fleet query), and best_of_n (parallel N-way comparison).
 * Destructive shapes (delete/kill/run-command/keystrokes) are deliberately absent;
 * adding one means adding an entry here AND its validator below — nothing executes
 * that isn't on this list. */
export const COMMAND_ACTION_IDS = [
  "create_session",
  "dispatch_issue",
  "open_view",
  "list_sessions",
  "best_of_n",
] as const;

/** Agents a created session may run. A subset of PROVIDER_IDS — excludes "shell"
 * (the chatbox creates AI-agent sessions, not bare terminals). Keep this in sync
 * with the New Session dialog options (components/NewSessionDialog) so Command
 * Stoa can create sessions for every AI agent the UI advertises. */
export const SESSION_AGENT_IDS = [
  "claude",
  "codex",
  "hermes",
  "kilo",
  "kimi",
] as const;
export type SessionAgentId = (typeof SESSION_AGENT_IDS)[number];

/** The validated, normalized params for a create_session action. Every field is
 * either a known-safe token (agentType in catalog, model a STATIC catalog token)
 * or sanitized free text (name/initialPrompt: control bytes stripped,
 * length-capped). The directory is NOT here — the executor derives it from
 * projectId server-side. */
export interface CreateSessionParams {
  projectId: string;
  agentType: SessionAgentId;
  model?: string;
  name?: string;
  /** Optional seed prompt — sent as the first keystroke to the session after it
   * starts. Control bytes stripped, length-capped at INITIAL_PROMPT_MAX. */
  initialPrompt?: string;
  /** Optional playbook (#13) recipe id — the route resolves + validates it (must be
   * global or belong to this project) and seeds its body into the prompt. An opaque
   * token; a bad/foreign id is simply ignored server-side. */
  playbookId?: string;
}

/** Views the open_view action can navigate to (client-side navigation only). */
export type CommandView =
  | "analytics"
  | "dispatch"
  | "verdict-inbox"
  | "fleet-board"
  | "fleet-management";

export const COMMAND_VIEWS: readonly CommandView[] = [
  "analytics",
  "dispatch",
  "verdict-inbox",
  "fleet-board",
  "fleet-management",
];

/** Validated params for dispatch_issue: create a local (GitHub-free) task
 * against a tracked dispatch repo. */
export interface DispatchIssueParams {
  repoId: string;
  title: string;
  body?: string;
}

/** Validated params for open_view: a pure client-side navigation instruction. */
export interface OpenViewParams {
  view: CommandView;
}

/** Validated params for list_sessions: read-only fleet query. */
export interface ListSessionsParams {
  status?: "running" | "idle" | "waiting";
}

/** Validated params for best_of_n: run N parallel sessions on the same task and
 * compare their diffs to pick a winner. n must be exactly 2 or 3.
 * conductorSessionId is the Stoa session that triggered this run — it is used as
 * the FK parent for the spawned workers (required by the DB schema). */
export interface BestOfNParams {
  task: string;
  n: 2 | 3;
  projectId: string;
  conductorSessionId: string;
}

/** A compact session summary returned by the list_sessions action. Shared between
 * the server executor (lib/command/list-sessions.ts) and the client hook
 * (data/chat/useCommand.ts) so both sides stay in sync at the type level. */
export interface SessionSummary {
  id: string;
  name: string;
  status: string;
  agentType: string;
  /** ISO timestamp of last update. */
  updatedAt: string;
}

export type CommandProposal =
  | { action: "create_session"; params: CreateSessionParams }
  | { action: "dispatch_issue"; params: DispatchIssueParams }
  | { action: "open_view"; params: OpenViewParams }
  | { action: "list_sessions"; params: ListSessionsParams }
  | { action: "best_of_n"; params: BestOfNParams };

export type ProposalValidation =
  { ok: true; proposal: CommandProposal } | { ok: false; reason: string };

const NAME_MAX = 80;
const INITIAL_PROMPT_MAX = 4000;
const ISSUE_TITLE_MAX = 200;
const ISSUE_BODY_MAX = 10000;

/**
 * Strip ASCII control bytes (keep tab/newline/carriage-return and any printable),
 * trim, and length-cap. Returns undefined for a non-string or empty result.
 *
 * Implemented as a numeric codePoint loop ON PURPOSE: writing a control-character
 * class as a regex literal risks baking real control bytes into this source file,
 * so we compare code points by number instead.
 */
function sanitizeText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  let out = "";
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    const isAllowedControl = c === 9 || c === 10 || c === 13; // tab, LF, CR
    const isPrintable = c >= 32 && c !== 127; // exclude the C0 range and DEL
    if (isAllowedControl || isPrintable) out += ch;
  }
  const trimmed = out.trim().slice(0, max);
  return trimmed.length > 0 ? trimmed : undefined;
}

function isSessionAgentId(value: unknown): value is SessionAgentId {
  return (
    typeof value === "string" &&
    (SESSION_AGENT_IDS as readonly string[]).includes(value)
  );
}

/**
 * Validate + normalize the params of a create_session proposal. Fail-closed on the
 * security-relevant fields (projectId required; agentType must be an allowed
 * agent), tolerant on the cosmetic ones (an unknown model is DROPPED to the
 * agent's default rather than rejecting the whole action; the name is sanitized).
 * projectId existence is the caller's job (needs the DB).
 */
export function validateCreateSessionParams(
  raw: Record<string, unknown>
): { ok: true; params: CreateSessionParams } | { ok: false; reason: string } {
  const projectId =
    typeof raw.projectId === "string" ? raw.projectId.trim() : "";
  if (!projectId) {
    return { ok: false, reason: "no project was specified" };
  }

  // agentType: default to claude when omitted (matches the New Session dialog),
  // but REJECT an explicitly-provided unsupported agent rather than silently
  // coercing it — so the confirm card can never misrepresent what will run.
  let agentType: SessionAgentId = "claude";
  if (raw.agentType !== undefined) {
    if (!isSessionAgentId(raw.agentType)) {
      return {
        ok: false,
        reason: `unsupported agent "${String(raw.agentType)}"`,
      };
    }
    agentType = raw.agentType;
  }

  // model: keep ONLY a STATIC catalog token (getModelOptions), never a free-text
  // value. Critical: isSupportedModelForAgent would accept ANY non-empty string
  // for a free-text agent (hermes), and that value rides UNESCAPED into the POSIX
  // tmux launch (`-m <model>`) — a prompt-injected `model` would be shell
  // injection. getModelOptions("hermes") is [] → a hermes model is always dropped
  // (it falls back to Hermes's own default), and claude/codex are clamped to their
  // fixed, shell-inert catalogs. Otherwise drop to the agent's default.
  let model: string | undefined;
  if (typeof raw.model === "string" && raw.model.trim()) {
    const candidate = raw.model.trim();
    if (getModelOptions(agentType).some((o) => o.value === candidate)) {
      model = candidate;
    }
  }

  const name = sanitizeText(raw.name, NAME_MAX);
  const initialPrompt = sanitizeText(raw.initialPrompt, INITIAL_PROMPT_MAX);
  // An opaque id token — the /api/sessions route resolves + project-scopes it, so we
  // only strip control bytes + cap length here (never trust it as a body).
  const playbookId = sanitizeText(raw.playbookId, NAME_MAX);

  const params: CreateSessionParams = { projectId, agentType };
  if (model) params.model = model;
  if (name) params.name = name;
  if (initialPrompt) params.initialPrompt = initialPrompt;
  if (playbookId) params.playbookId = playbookId;
  return { ok: true, params };
}

/**
 * Validate + normalize params for a dispatch_issue proposal. repoId and title
 * are required; body is optional. Existence of repoId is left to the caller
 * (needs the DB).
 */
export function validateDispatchIssueParams(
  raw: Record<string, unknown>
): { ok: true; params: DispatchIssueParams } | { ok: false; reason: string } {
  const repoId = sanitizeText(raw.repoId, 128) ?? "";
  if (!repoId) {
    return { ok: false, reason: "no repo was specified" };
  }
  const title = sanitizeText(raw.title, ISSUE_TITLE_MAX);
  if (!title) {
    return { ok: false, reason: "a non-empty issue title is required" };
  }
  const body = sanitizeText(raw.body, ISSUE_BODY_MAX);
  const params: DispatchIssueParams = { repoId, title };
  if (body) params.body = body;
  return { ok: true, params };
}

/**
 * Validate params for an open_view proposal. The view must be one of the
 * allowed COMMAND_VIEWS tokens (fail-closed — never accepts an arbitrary string).
 */
export function validateOpenViewParams(
  raw: Record<string, unknown>
): { ok: true; params: OpenViewParams } | { ok: false; reason: string } {
  const view = raw.view;
  if (
    typeof view !== "string" ||
    !(COMMAND_VIEWS as readonly string[]).includes(view)
  ) {
    return {
      ok: false,
      reason: `"${String(view)}" is not a navigable view (choose one of: ${COMMAND_VIEWS.join(", ")})`,
    };
  }
  return { ok: true, params: { view: view as CommandView } };
}

/**
 * Validate params for a list_sessions proposal. status is optional; if provided
 * it must be one of the allowed values (fail-closed).
 */
export function validateListSessionsParams(
  raw: Record<string, unknown>
): { ok: true; params: ListSessionsParams } | { ok: false; reason: string } {
  const STATUS_VALUES = ["running", "idle", "waiting"] as const;
  type StatusValue = (typeof STATUS_VALUES)[number];
  const params: ListSessionsParams = {};
  if (raw.status !== undefined) {
    if (
      typeof raw.status !== "string" ||
      !(STATUS_VALUES as readonly string[]).includes(raw.status)
    ) {
      return {
        ok: false,
        reason: `"${String(raw.status)}" is not a valid session status (choose one of: ${STATUS_VALUES.join(", ")})`,
      };
    }
    params.status = raw.status as StatusValue;
  }
  return { ok: true, params };
}

const BON_TASK_MAX = 4000;

/**
 * Validate params for a best_of_n proposal.
 *
 * - task: required, non-empty, control bytes stripped, max 4000 chars.
 * - n: must be exactly 2 or 3 (integer). Fail-closed — not "up to 3".
 * - projectId: required non-empty string (existence checked by the executor).
 */
export function validateBestOfNParams(
  raw: Record<string, unknown>
): { ok: true; params: BestOfNParams } | { ok: false; reason: string } {
  const task = sanitizeText(raw.task, BON_TASK_MAX);
  if (!task) {
    return { ok: false, reason: "a non-empty task is required" };
  }

  const projectId =
    typeof raw.projectId === "string" ? raw.projectId.trim() : "";
  if (!projectId) {
    return { ok: false, reason: "no project was specified" };
  }

  // n must be exactly 2 or 3 — no coercion, no other value.
  const rawN = raw.n;
  if (rawN !== 2 && rawN !== 3) {
    return {
      ok: false,
      reason: `n must be exactly 2 or 3 (got ${JSON.stringify(rawN)})`,
    };
  }

  const conductorSessionId =
    typeof raw.conductorSessionId === "string"
      ? raw.conductorSessionId.trim()
      : "";
  if (!conductorSessionId) {
    return { ok: false, reason: "conductorSessionId is required" };
  }

  return {
    ok: true,
    params: { task, n: rawN as 2 | 3, projectId, conductorSessionId },
  };
}

/**
 * Validate an arbitrary (agent- or client-supplied) value as a command proposal.
 * Fail-closed: the action must be exactly an allowlisted id, and its params must
 * pass that action's per-validator. Anything else returns { ok: false, reason }.
 */
export function validateProposal(raw: unknown): ProposalValidation {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "the proposal was not an object" };
  }
  const obj = raw as Record<string, unknown>;
  // Fail-closed against the allowlist const (so the validator and the id list can
  // never drift).
  if (
    typeof obj.action !== "string" ||
    !(COMMAND_ACTION_IDS as readonly string[]).includes(obj.action)
  ) {
    return {
      ok: false,
      reason: `"${String(obj.action)}" is not an action I can run`,
    };
  }
  const paramsRaw =
    obj.params && typeof obj.params === "object"
      ? (obj.params as Record<string, unknown>)
      : {};

  switch (obj.action) {
    case "create_session": {
      const res = validateCreateSessionParams(paramsRaw);
      if (!res.ok) return res;
      return {
        ok: true,
        proposal: { action: "create_session", params: res.params },
      };
    }
    case "dispatch_issue": {
      const res = validateDispatchIssueParams(paramsRaw);
      if (!res.ok) return res;
      return {
        ok: true,
        proposal: { action: "dispatch_issue", params: res.params },
      };
    }
    case "open_view": {
      const res = validateOpenViewParams(paramsRaw);
      if (!res.ok) return res;
      return {
        ok: true,
        proposal: { action: "open_view", params: res.params },
      };
    }
    case "list_sessions": {
      const res = validateListSessionsParams(paramsRaw);
      if (!res.ok) return res;
      return {
        ok: true,
        proposal: { action: "list_sessions", params: res.params },
      };
    }
    case "best_of_n": {
      const res = validateBestOfNParams(paramsRaw);
      if (!res.ok) return res;
      return {
        ok: true,
        proposal: { action: "best_of_n", params: res.params },
      };
    }
    default:
      return {
        ok: false,
        reason: `"${String(obj.action)}" is not an action I can run`,
      };
  }
}

// ─── Plan schema ──────────────────────────────────────────────────────────────

/** The result of executing one step in a plan. Defined here (pure, no server
 * deps) so client-side code can import the type without pulling in server-only
 * modules such as better-sqlite3 or lib/db. */
export interface StepResult {
  stepId: string;
  ok: boolean;
  summary: string;
  sessionId?: string;
  dispatchId?: string;
  error?: string;
}

/** The actions a plan step may perform (a strict subset of COMMAND_ACTION_IDS —
 * open_view and list_sessions produce no meaningful sequential work). */
export const PLAN_STEP_ACTION_IDS = [
  "create_session",
  "dispatch_issue",
] as const;
export type PlanStepActionId = (typeof PLAN_STEP_ACTION_IDS)[number];

/** One step in a multi-step plan proposed by the LLM. */
export interface PlanStep {
  /** Unique within the plan. Alphanum + hyphens only, max 32 chars. */
  stepId: string;
  /** Human-readable label shown in the plan card. Max 200 chars. */
  description: string;
  action: PlanStepActionId;
  params: CreateSessionParams | DispatchIssueParams;
}

/** A validated plan ready to present in the UI. */
export interface ExecutePlanParams {
  name: string;
  steps: PlanStep[];
}

export type PlanValidation =
  { ok: true; name: string; steps: PlanStep[] } | { ok: false; reason: string };

const PLAN_NAME_MAX = 120;
const PLAN_STEP_DESCRIPTION_MAX = 200;
const PLAN_STEP_ID_MAX = 32;
const PLAN_MIN_STEPS = 2;
const PLAN_MAX_STEPS = 10;

/** Valid step id: alphanum chars plus hyphens and underscores, non-empty. */
function isValidStepId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value) && value.length <= PLAN_STEP_ID_MAX;
}

/**
 * Validate an LLM- or client-supplied plan. Fail-closed: every step must have a
 * known action and params that pass the per-action validator; any unknown field,
 * out-of-range count, or invalid stepId → { ok: false, reason }.
 *
 * Plans travel a PARALLEL path to single proposals: execute_plan is NOT on
 * COMMAND_ACTION_IDS, so this validator is called only when `kind === "plan"` is
 * detected. It reuses the existing per-action validators for each step's params,
 * keeping the validation contract identical.
 */
export function validatePlan(raw: unknown): PlanValidation {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "the plan was not an object" };
  }
  const obj = raw as Record<string, unknown>;

  if (obj.kind !== "plan") {
    return { ok: false, reason: 'the plan object is missing "kind":"plan"' };
  }

  const name = sanitizeText(obj.name, PLAN_NAME_MAX);
  if (!name) {
    return { ok: false, reason: "the plan is missing a non-empty name" };
  }

  if (!Array.isArray(obj.steps)) {
    return { ok: false, reason: "steps must be an array" };
  }
  if (obj.steps.length < PLAN_MIN_STEPS) {
    return {
      ok: false,
      reason: `a plan needs at least ${PLAN_MIN_STEPS} steps (got ${obj.steps.length})`,
    };
  }
  if (obj.steps.length > PLAN_MAX_STEPS) {
    return {
      ok: false,
      reason: `a plan may have at most ${PLAN_MAX_STEPS} steps (got ${obj.steps.length})`,
    };
  }

  const steps: PlanStep[] = [];
  const seenStepIds = new Set<string>();
  for (let i = 0; i < obj.steps.length; i++) {
    const stepRaw = obj.steps[i];
    if (!stepRaw || typeof stepRaw !== "object") {
      return { ok: false, reason: `step ${i + 1} is not an object` };
    }
    const s = stepRaw as Record<string, unknown>;

    // stepId: alphanum+hyphens, non-empty, max 32 chars
    const stepId = typeof s.stepId === "string" ? s.stepId.trim() : "";
    if (!stepId) {
      return { ok: false, reason: `step ${i + 1} is missing a stepId` };
    }
    if (!isValidStepId(stepId)) {
      return {
        ok: false,
        reason: `step ${i + 1} has an invalid stepId "${stepId}" (only alphanum + hyphens/underscores, max ${PLAN_STEP_ID_MAX} chars)`,
      };
    }
    // Duplicate stepId would corrupt the client progress map — reject the whole plan.
    if (seenStepIds.has(stepId)) {
      return {
        ok: false,
        reason: `duplicate stepId "${stepId}" at step ${i + 1} — stepIds must be unique within the plan`,
      };
    }
    seenStepIds.add(stepId);

    const description = sanitizeText(s.description, PLAN_STEP_DESCRIPTION_MAX);
    if (!description) {
      return {
        ok: false,
        reason: `step ${i + 1} (${stepId}) is missing a non-empty description`,
      };
    }

    // action: only the plan-step allowlist (not the full COMMAND_ACTION_IDS)
    if (
      typeof s.action !== "string" ||
      !(PLAN_STEP_ACTION_IDS as readonly string[]).includes(s.action)
    ) {
      return {
        ok: false,
        reason: `step ${i + 1} (${stepId}) has an unsupported action "${String(s.action)}" — only ${PLAN_STEP_ACTION_IDS.join(", ")} are allowed in a plan`,
      };
    }
    const action = s.action as PlanStepActionId;

    const paramsRaw =
      s.params && typeof s.params === "object"
        ? (s.params as Record<string, unknown>)
        : {};

    if (action === "create_session") {
      const res = validateCreateSessionParams(paramsRaw);
      if (!res.ok) {
        return {
          ok: false,
          reason: `step ${i + 1} (${stepId}) create_session params invalid: ${res.reason}`,
        };
      }
      steps.push({ stepId, description, action, params: res.params });
    } else {
      // dispatch_issue
      const res = validateDispatchIssueParams(paramsRaw);
      if (!res.ok) {
        return {
          ok: false,
          reason: `step ${i + 1} (${stepId}) dispatch_issue params invalid: ${res.reason}`,
        };
      }
      steps.push({ stepId, description, action, params: res.params });
    }
  }

  return { ok: true, name, steps };
}

/**
 * A human-readable summary of what a plan will do, for display in history or
 * audit logs. Lists each step on its own line.
 */
export function describePlan(
  name: string,
  steps: PlanStep[],
  /** Optional map of projectId → projectName for create_session steps. */
  projectNames?: Record<string, string>
): string {
  const header = `Plan: "${name}" — ${steps.length} step${steps.length === 1 ? "" : "s"}`;
  const lines = steps.map((step, i) => {
    let where = "";
    if (step.action === "create_session") {
      const p = step.params as CreateSessionParams;
      const projName = projectNames?.[p.projectId];
      where = projName ? ` in ${projName}` : "";
    }
    return `  ${i + 1}. [${step.action}] ${step.description}${where}`;
  });
  return [header, ...lines].join("\n");
}

// Caps for generated-step free text (control bytes stripped, length-bounded so a
// crafted reply can't bloat the canvas/DB row). Tasks are multi-line prompts.
const TASK_MAX = 6000;
const EXIT_CRITERIA_MAX = 2000;
const WORKFLOW_NAME_MAX = 120;

/** A generated workflow design: either a laid-out BuilderDoc ready to load into
 * the canvas, or a reason it was rejected (which degrades to a plain answer). */
export type WorkflowValidation =
  { ok: true; doc: BuilderDoc } | { ok: false; reason: string };

/**
 * Validate an LLM-generated workflow design into a laid-out BuilderDoc. This is
 * the generator's fail-closed gate — the exact twin of validateProposal for the
 * "assisted design workflow" feature. It NEVER executes anything: it produces a
 * draft document the user reviews and (separately, explicitly) chooses to run.
 *
 * Posture (mirrors parseBuilderDoc + validateCreateSessionParams):
 *  - each step's fields are whitelisted one-by-one — the raw object is never
 *    spread, so junk/hostile fields can't ride into the doc;
 *  - the agent comes ONLY from the role map; an unknown role fails the whole
 *    design closed (no silent coercion); any LLM-supplied agent / model /
 *    workingDirectory / worktreePolicy is DROPPED (the server owns those);
 *  - the working directory is set SERVER-SIDE from the resolved project (the
 *    agent never supplies a path);
 *  - the assembled spec must pass the SAME validateSpec gate hand-built specs
 *    pass (unique ids, acyclic, output-refs in the dependency closure, ...), so a
 *    near-miss DAG is rejected here rather than producing a broken canvas.
 */
export function validateWorkflowProposal(
  raw: unknown,
  opts: { projectId: string; projectDir: string }
): WorkflowValidation {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "the workflow design was not an object" };
  }
  const specRaw = (raw as Record<string, unknown>).spec;
  if (!specRaw || typeof specRaw !== "object") {
    return { ok: false, reason: "the design has no spec object" };
  }
  const s = specRaw as Record<string, unknown>;
  if (!Array.isArray(s.steps) || s.steps.length === 0) {
    return { ok: false, reason: "the design has no steps" };
  }
  if (s.steps.length > MAX_GENERATED_STEPS) {
    return {
      ok: false,
      reason: `the design has too many steps (${s.steps.length} > ${MAX_GENERATED_STEPS})`,
    };
  }

  const name = sanitizeText(s.name, WORKFLOW_NAME_MAX) ?? "Generated workflow";

  const steps: PipelineStep[] = [];
  for (const stepRaw of s.steps) {
    if (!stepRaw || typeof stepRaw !== "object") {
      return { ok: false, reason: "a step was not an object" };
    }
    const r = stepRaw as Record<string, unknown>;
    // role is the fail-closed gate: an unknown role rejects the whole design
    // rather than coercing to a default agent.
    if (!isWorkflowRole(r.role)) {
      return { ok: false, reason: `unknown role "${String(r.role)}"` };
    }
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (!id) {
      return { ok: false, reason: "a step is missing its id" };
    }
    const step: PipelineStep = {
      id,
      agent: ROLE_TO_AGENT[r.role],
      task: sanitizeText(r.task, TASK_MAX) ?? "",
    };
    const stepName = sanitizeText(r.name, NAME_MAX);
    if (stepName) step.name = stepName;
    // dependsOn: only a clean string[] (trimmed to match the step ids); a
    // malformed value is dropped (the step becomes a root) — same as parseBuilderDoc.
    if (
      Array.isArray(r.dependsOn) &&
      r.dependsOn.every((d) => typeof d === "string")
    ) {
      step.dependsOn = (r.dependsOn as string[]).map((d) => d.trim());
    }
    if (typeof r.outputFile === "string" && r.outputFile.trim()) {
      step.outputFile = r.outputFile.trim();
    }
    const exit = sanitizeText(r.exitCriteria, EXIT_CRITERIA_MAX);
    if (exit) step.exitCriteria = exit;
    steps.push(step);
  }

  const spec: PipelineSpec = {
    name,
    workingDirectory: opts.projectDir,
    steps,
  };
  const validation = validateSpec(spec);
  if (!validation.valid) {
    const first = validation.errors[0];
    return {
      ok: false,
      reason: first ? first.message : "the design failed validation",
    };
  }
  // Lay it out and stamp the resolved project so the canvas opens grounded.
  return { ok: true, doc: { ...docFromSpec(spec), projectId: opts.projectId } };
}

/**
 * A human one-line description of what a proposal will do, for the confirm card.
 * For create_session, the projectName is resolved by the caller (from the DB) —
 * never the raw id. The model is surfaced (when set) so the operator confirms
 * exactly what will run.
 */
export function describeProposal(
  proposal: CommandProposal,
  /** The resolved project name (for create_session / dispatch_issue) or repo name
   * (for dispatch_issue). Pass an empty string for actions that don't need it. */
  contextName: string
): string {
  if (proposal.action === "create_session") {
    const p = proposal.params;
    const agentLabel = getProviderDefinition(p.agentType).name;
    const named = p.name ? ` named "${p.name}"` : "";
    const onModel = p.model ? ` on ${p.model}` : "";
    const withPrompt = p.initialPrompt
      ? ` with initial prompt "${p.initialPrompt.slice(0, 60)}${p.initialPrompt.length > 60 ? "..." : ""}"`
      : "";
    return `Create a new ${agentLabel} session${named}${onModel}${withPrompt} in ${contextName}.`;
  }
  if (proposal.action === "dispatch_issue") {
    const p = proposal.params;
    const inRepo = contextName ? ` in ${contextName}` : "";
    return `Create a local dispatch task: "${p.title.slice(0, 60)}${p.title.length > 60 ? "..." : ""}"${inRepo}.`;
  }
  if (proposal.action === "open_view") {
    return `Navigate to the ${proposal.params.view} view.`;
  }
  if (proposal.action === "list_sessions") {
    const { status } = proposal.params;
    return status
      ? `List all ${status} sessions.`
      : "List all current sessions.";
  }
  if (proposal.action === "best_of_n") {
    const { n, task } = proposal.params;
    const truncated = task.length > 60 ? `${task.slice(0, 60)}...` : task;
    const inProject = contextName ? ` in ${contextName}` : "";
    return `Run ${n} parallel sessions on: "${truncated}"${inProject} and compare their results.`;
  }
  return "Run action.";
}
