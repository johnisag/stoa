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

/** The actions Command Stoa can perform. Phase 2 ships ONE: create_session — the
 * same capability as the New Session dialog (cheap, non-destructive, killable).
 * Destructive shapes (delete/kill/run-command/keystrokes) are deliberately absent;
 * adding one means adding an entry here AND its validator below — nothing executes
 * that isn't on this list. */
export const COMMAND_ACTION_IDS = ["create_session"] as const;

/** Agents a created session may run. A subset of PROVIDER_IDS — excludes "shell"
 * (the chatbox creates AI-agent sessions, not bare terminals). */
export const SESSION_AGENT_IDS = ["claude", "codex", "hermes"] as const;
export type SessionAgentId = (typeof SESSION_AGENT_IDS)[number];

/** The validated, normalized params for a create_session action. Every field is
 * either a known-safe token (agentType in catalog, model a STATIC catalog token)
 * or sanitized free text (name: control bytes stripped, length-capped). The
 * directory is NOT here — the executor derives it from projectId server-side. */
export interface CreateSessionParams {
  projectId: string;
  agentType: SessionAgentId;
  model?: string;
  name?: string;
}

export interface CommandProposal {
  action: "create_session";
  params: CreateSessionParams;
}

export type ProposalValidation =
  | { ok: true; proposal: CommandProposal }
  | { ok: false; reason: string };

const NAME_MAX = 80;

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

  const params: CreateSessionParams = { projectId, agentType };
  if (model) params.model = model;
  if (name) params.name = name;
  return { ok: true, params };
}

/**
 * Validate an arbitrary (agent- or client-supplied) value as a command proposal.
 * Fail-closed: the action must be exactly an allowlisted id, and its params must
 * pass that action's validator. Anything else returns { ok: false, reason }.
 */
export function validateProposal(raw: unknown): ProposalValidation {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "the proposal was not an object" };
  }
  const obj = raw as Record<string, unknown>;
  // Fail-closed against the allowlist const (so the validator and the id list can
  // never drift). Today there is exactly one action: create_session.
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
  const res = validateCreateSessionParams(paramsRaw);
  if (!res.ok) return res;
  return {
    ok: true,
    proposal: { action: "create_session", params: res.params },
  };
}

/**
 * A human one-line description of what a proposal will do, for the confirm card.
 * The projectName is resolved by the caller (from the DB) — never the raw id. The
 * model is surfaced (when set) so the operator confirms exactly what will run.
 */
export function describeProposal(
  proposal: CommandProposal,
  projectName: string
): string {
  const p = proposal.params;
  const agentLabel = getProviderDefinition(p.agentType).name;
  const named = p.name ? ` named “${p.name}”` : "";
  const onModel = p.model ? ` on ${p.model}` : "";
  return `Create a new ${agentLabel} session${named}${onModel} in ${projectName}.`;
}
