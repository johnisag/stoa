import { describe, it, expect } from "vitest";
import {
  getModelOptions,
  getDefaultModelForAgent,
  isSupportedModelForAgent,
  resolveModelForAgent,
  isFreeTextModelAgent,
  nextModelOnAgentChange,
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

  it("offers no static list but has an explicit default model", () => {
    expect(getModelOptions("hermes")).toEqual([]);
    // Hermes is free-text (no dropdown) but Stoa gives it an explicit default so
    // a fresh session launches `hermes -m claude-opus-4-8` (a full model name —
    // the shorthand "opus" 404s).
    expect(getDefaultModelForAgent("hermes")).toBe("claude-opus-4-8");
  });

  it("accepts any non-empty model verbatim; empty → the configured default", () => {
    expect(
      isSupportedModelForAgent("hermes", "anthropic/claude-sonnet-4.6")
    ).toBe(true);
    expect(isSupportedModelForAgent("hermes", "")).toBe(false);
    // free-text passes through (trimmed), never coerced to a catalog value
    expect(resolveModelForAgent("hermes", "  openrouter/x  ")).toBe(
      "openrouter/x"
    );
    // empty/missing → the configured Hermes default
    expect(resolveModelForAgent("hermes", "")).toBe("claude-opus-4-8");
    expect(resolveModelForAgent("hermes", null)).toBe("claude-opus-4-8");
    expect(resolveModelForAgent("hermes", undefined)).toBe("claude-opus-4-8");
  });

  it("does NOT inherit another agent's static model (the opus 404 bug)", () => {
    // A project's default_model column defaults to "sonnet" (Claude-centric) and
    // can be "opus"/a Codex id. Passing that to Hermes would yield `hermes -m
    // opus` → Anthropic 404 model: opus. resolveModelForAgent must drop a
    // foreign static model and fall back to Hermes's own default instead.
    expect(resolveModelForAgent("hermes", "opus")).toBe("claude-opus-4-8");
    expect(resolveModelForAgent("hermes", "sonnet")).toBe("claude-opus-4-8");
    expect(resolveModelForAgent("hermes", "haiku")).toBe("claude-opus-4-8");
    expect(resolveModelForAgent("hermes", "gpt-5.4")).toBe("claude-opus-4-8");
    // but a genuine provider-qualified Hermes model still passes through
    expect(resolveModelForAgent("hermes", "anthropic/claude-opus-4.8")).toBe(
      "anthropic/claude-opus-4.8"
    );
  });
});

describe("nextModelOnAgentChange (model carry-over on agent switch)", () => {
  it("static -> free-text: resets to the free-text agent's default (no leak)", () => {
    // No static model name leaks into Hermes; it resets to Hermes's own default.
    expect(nextModelOnAgentChange("hermes", "sonnet")).toBe("claude-opus-4-8");
    expect(nextModelOnAgentChange("hermes", "gpt-5.4")).toBe("claude-opus-4-8");
  });

  it("free-text -> static: drops the free-text value for the static default", () => {
    expect(
      nextModelOnAgentChange("claude", "anthropic/claude-sonnet-4.6")
    ).toBe("sonnet");
  });

  it("static -> static: keeps a valid model, else the new agent's default", () => {
    expect(nextModelOnAgentChange("claude", "opus")).toBe("opus");
    expect(nextModelOnAgentChange("codex", "sonnet")).toBe("gpt-5.4");
  });
});
