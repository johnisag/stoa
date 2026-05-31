import { describe, it, expect } from "vitest";
import {
  getModelOptions,
  getDefaultModelForAgent,
  isSupportedModelForAgent,
  resolveModelForAgent,
  isFreeTextModelAgent,
} from "@/lib/model-catalog";

describe("model catalog — static agents (claude/codex)", () => {
  it("claude: dropdown list + sonnet default + validates against the list", () => {
    expect(getModelOptions("claude").length).toBeGreaterThan(0);
    expect(getDefaultModelForAgent("claude")).toBe("sonnet");
    expect(isSupportedModelForAgent("claude", "opus")).toBe(true);
    expect(isSupportedModelForAgent("claude", "not-a-model")).toBe(false);
    expect(resolveModelForAgent("claude", "opus")).toBe("opus");
    expect(resolveModelForAgent("claude", "bogus")).toBe("sonnet"); // invalid → default
  });
});

describe("model catalog — free-text agents (hermes)", () => {
  it("is flagged free-text (vs. static agents)", () => {
    expect(isFreeTextModelAgent("hermes")).toBe(true);
    expect(isFreeTextModelAgent("claude")).toBe(false);
    expect(isFreeTextModelAgent("codex")).toBe(false);
  });

  it("offers no static list and no default (the agent picks its own)", () => {
    expect(getModelOptions("hermes")).toEqual([]);
    expect(getDefaultModelForAgent("hermes")).toBe("");
  });

  it("accepts any non-empty model verbatim; empty → agent default", () => {
    expect(
      isSupportedModelForAgent("hermes", "anthropic/claude-sonnet-4.6")
    ).toBe(true);
    expect(isSupportedModelForAgent("hermes", "")).toBe(false);
    // free-text passes through (trimmed), never coerced to a catalog value
    expect(resolveModelForAgent("hermes", "  openrouter/x  ")).toBe(
      "openrouter/x"
    );
    expect(resolveModelForAgent("hermes", "")).toBe("");
    expect(resolveModelForAgent("hermes", null)).toBe("");
    expect(resolveModelForAgent("hermes", undefined)).toBe("");
  });
});
