import type { AgentType } from "./providers";

export interface ModelOption {
  value: string;
  label: string;
}

const CLAUDE_MODEL_OPTIONS: ModelOption[] = [
  { value: "sonnet", label: "Sonnet" },
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

const DEFAULT_MODEL_BY_AGENT: Partial<Record<AgentType, string>> = {
  claude: "sonnet",
  codex: "gpt-5.4",
};

// Agents whose models are dynamic/provider-specific (no fixed catalog). For
// these the UI offers a FREE-TEXT model field instead of a dropdown, and any
// non-empty value is accepted verbatim. Empty means "use the agent's own
// default" (no model flag passed). Hermes live-fetches models via `hermes model`.
const FREE_TEXT_MODEL_AGENTS = new Set<AgentType>(["hermes"]);

export function isFreeTextModelAgent(agentType: AgentType): boolean {
  return FREE_TEXT_MODEL_AGENTS.has(agentType);
}

export function getModelOptions(agentType: AgentType): ModelOption[] {
  // Free-text agents have no fixed list (empty array signals a text input).
  if (isFreeTextModelAgent(agentType)) return [];
  return MODEL_OPTIONS_BY_AGENT[agentType] ?? CLAUDE_MODEL_OPTIONS;
}

export function getDefaultModelForAgent(agentType: AgentType): string {
  // Free-text agents default to empty → the agent picks its own default.
  if (isFreeTextModelAgent(agentType)) return "";
  return (
    DEFAULT_MODEL_BY_AGENT[agentType] ??
    getModelOptions(agentType)[0]?.value ??
    "sonnet"
  );
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

  // Free-text agents: pass the typed value through as-is (empty → agent default).
  if (isFreeTextModelAgent(agentType)) {
    return normalizedModel ?? "";
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
