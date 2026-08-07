import {
  getDefaultModelForAgent,
  getModelOptions,
  type ModelOption,
} from "./model-catalog";

export type AskProvider = "claude" | "codex" | "hermes";

export const ASK_PROVIDERS: readonly AskProvider[] = [
  "claude",
  "codex",
  "hermes",
] as const;

const ASK_DEFAULT_MODEL: Record<AskProvider, string> = {
  claude: "opus",
  codex: "gpt-5.4",
  hermes: getDefaultModelForAgent("hermes"),
};

export function defaultAskModel(provider: AskProvider): string {
  return ASK_DEFAULT_MODEL[provider];
}

/** Models trusted for Ask Stoa's argv boundary. Hermes remains dynamic in
 * normal sessions, but Ask Stoa exposes only its Stoa-owned default. */
export function getAskModelOptions(provider: AskProvider): ModelOption[] {
  if (provider === "hermes") {
    const model = defaultAskModel(provider);
    return [{ value: model, label: "Kimi K3" }];
  }
  return getModelOptions(provider);
}

export function isAskModel(
  provider: AskProvider,
  model: unknown
): model is string {
  return (
    typeof model === "string" &&
    getAskModelOptions(provider).some((option) => option.value === model)
  );
}
