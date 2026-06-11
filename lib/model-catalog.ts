import type { AgentType } from "./providers";

export interface ModelOption {
  value: string;
  label: string;
}

// Default first (Sonnet), matching the Codex list — the top item is the default,
// not a "most capable" ranking. Values are unversioned family aliases ('fable'
// resolves to the latest Fable), so labels stay unversioned too.
const CLAUDE_MODEL_OPTIONS: ModelOption[] = [
  { value: "sonnet", label: "Sonnet" },
  { value: "fable", label: "Fable" },
  { value: "opus", label: "Opus" },
  { value: "haiku", label: "Haiku" },
];

const CODEX_MODEL_OPTIONS: ModelOption[] = [
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 mini" },
  { value: "gpt-5.4-nano", label: "GPT-5.4 nano" },
  { value: "gpt-5.2-codex", label: "GPT-5.2-Codex" },
];

const MODEL_OPTIONS_BY_AGENT: Partial<Record<AgentType, ModelOption[]>> = {
  claude: CLAUDE_MODEL_OPTIONS,
  codex: CODEX_MODEL_OPTIONS,
};

// Hermes is free-text (no dropdown), but Stoa gives it an explicit default so a
// fresh session launches `hermes -m <model>` rather than relying on whatever
// Hermes happens to be configured for. Must be a FULL provider model name — the
// shorthand "opus" 404s (`hermes -m opus` → anthropic model: opus). Verified
// against the live backend: `hermes model` reports "claude-opus-4-8" (dash).
export const HERMES_DEFAULT_MODEL = "claude-opus-4-8";

const DEFAULT_MODEL_BY_AGENT: Partial<Record<AgentType, string>> = {
  claude: "sonnet",
  codex: "gpt-5.4",
  hermes: HERMES_DEFAULT_MODEL,
};

// Agents whose models are dynamic/provider-specific (no fixed catalog). For
// these the UI offers a FREE-TEXT model field instead of a dropdown, and any
// non-empty value is accepted verbatim. Empty means "use the agent's own
// default" (no model flag passed). Hermes live-fetches models via `hermes model`.
const FREE_TEXT_MODEL_AGENTS = new Set<AgentType>(["hermes"]);

export function isFreeTextModelAgent(agentType: AgentType): boolean {
  return FREE_TEXT_MODEL_AGENTS.has(agentType);
}

/**
 * True if `model` is a static catalog value belonging to a DIFFERENT (static)
 * agent — e.g. "opus"/"sonnet" (Claude) or "gpt-5.4" (Codex). Used to stop a
 * project's Claude/Codex `default_model` (the column defaults to "sonnet") from
 * leaking into a free-text agent like Hermes, which would then forward the bogus
 * name to its backend (`hermes -m opus` → Anthropic 404 model: opus).
 */
function isForeignStaticModel(agentType: AgentType, model: string): boolean {
  return Object.entries(MODEL_OPTIONS_BY_AGENT).some(
    ([id, options]) =>
      id !== agentType &&
      (options ?? []).some((option) => option.value === model)
  );
}

export function getModelOptions(agentType: AgentType): ModelOption[] {
  // Free-text agents have no fixed list (empty array signals a text input).
  if (isFreeTextModelAgent(agentType)) return [];
  return MODEL_OPTIONS_BY_AGENT[agentType] ?? CLAUDE_MODEL_OPTIONS;
}

export function getDefaultModelForAgent(agentType: AgentType): string {
  const configured = DEFAULT_MODEL_BY_AGENT[agentType];
  if (configured) return configured;
  // A free-text agent with no configured default → empty (agent picks its own).
  if (isFreeTextModelAgent(agentType)) return "";
  return getModelOptions(agentType)[0]?.value ?? "sonnet";
}

export function isSupportedModelForAgent(
  agentType: AgentType,
  model: string | null | undefined
): boolean {
  if (!model) {
    return false;
  }

  // Free-text agents accept any non-empty model verbatim.
  if (isFreeTextModelAgent(agentType)) return true;

  return getModelOptions(agentType).some((option) => option.value === model);
}

export function resolveModelForAgent(
  agentType: AgentType,
  model: string | null | undefined
): string {
  const normalizedModel =
    typeof model === "string" && model.trim() ? model.trim() : null;

  // Free-text agents: pass a genuine typed model through as-is. But fall back to
  // the agent's configured default for (a) empty input and (b) a static model
  // that belongs to ANOTHER agent's catalog (e.g. a project's "opus"/"sonnet"
  // default_model) — forwarding that would 404 (`hermes -m opus`). A genuine
  // free-text model (provider-qualified, e.g. "anthropic/claude-opus-4.8")
  // matches no static catalog and passes through.
  if (isFreeTextModelAgent(agentType)) {
    if (normalizedModel && !isForeignStaticModel(agentType, normalizedModel)) {
      return normalizedModel;
    }
    return getDefaultModelForAgent(agentType);
  }

  if (normalizedModel && isSupportedModelForAgent(agentType, normalizedModel)) {
    return normalizedModel;
  }

  return getDefaultModelForAgent(agentType);
}

/**
 * The default-model value to use when a form's selected agent changes to
 * `nextAgent`, carrying the previously-selected `currentModel` only when it
 * makes sense.
 *
 * Switching TO a free-text agent always resets to its default (empty) — a
 * static model name (e.g. "sonnet") accepted verbatim by a free-text agent
 * would otherwise leak into its field and be passed as a bogus `-m`. Switching
 * to a static agent keeps the current model if it's valid there, else the
 * agent's default.
 */
export function nextModelOnAgentChange(
  nextAgent: AgentType,
  currentModel: string | null | undefined
): string {
  if (isFreeTextModelAgent(nextAgent)) {
    return getDefaultModelForAgent(nextAgent);
  }
  if (currentModel && isSupportedModelForAgent(nextAgent, currentModel)) {
    return currentModel;
  }
  return getDefaultModelForAgent(nextAgent);
}
