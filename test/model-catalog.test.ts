import { describe, it, expect } from "vitest";
import {
  getModelOptions,
  getDefaultModelForAgent,
  isSupportedModelForAgent,
  resolveModelForAgent,
  isFreeTextModelAgent,
  nextModelOnAgentChange,
  isSafeModel,
} from "@/lib/model-catalog";

describe("isSafeModel — shell-safe model-id guard (POSIX tmux `-m` injection defense)", () => {
  it("accepts catalog + provider-qualified model ids", () => {
    for (const m of [
      "sonnet",
      "opus",
      "gpt-5.4-mini",
      "claude-opus-4-8",
      "anthropic/claude-opus-4.8",
    ]) {
      expect(isSafeModel(m)).toBe(true);
    }
  });

  it("rejects shell metacharacters that could break out of the `-m <model>` launch", () => {
    for (const m of [
      "a b",
      "x; rm -rf /",
      "a|b",
      "$(whoami)",
      "`id`",
      'a"b',
      "a'b",
      "a&b",
      "a\nb",
    ]) {
      expect(isSafeModel(m)).toBe(false);
    }
  });
});

describe("model catalog — static agents (claude/codex)", () => {
  it("claude: dropdown list + sonnet default + validates against the list", () => {
    expect(getModelOptions("claude").length).toBeGreaterThan(0);
    expect(getDefaultModelForAgent("claude")).toBe("sonnet");
    expect(isSupportedModelForAgent("claude", "opus")).toBe(true);
    expect(isSupportedModelForAgent("claude", "not-a-model")).toBe(false);
    expect(resolveModelForAgent("claude", "opus")).toBe("opus");
    expect(resolveModelForAgent("claude", "bogus")).toBe("sonnet"); // invalid → default
  });

  it("codex: dropdown list + gpt-5.5 default + validates against the list", () => {
    expect(getModelOptions("codex").length).toBeGreaterThan(0);
    expect(getDefaultModelForAgent("codex")).toBe("gpt-5.5");
    expect(isSupportedModelForAgent("codex", "gpt-5.5")).toBe(true);
    expect(isSupportedModelForAgent("codex", "gpt-5.2-codex")).toBe(false);
    expect(resolveModelForAgent("codex", "gpt-5.3-codex")).toBe(
      "gpt-5.3-codex"
    );
    expect(resolveModelForAgent("codex", "bogus")).toBe("gpt-5.5"); // invalid → default
  });
});

describe("model catalog — free-text agents (hermes, kilo, kimi)", () => {
  it("is flagged free-text (vs. static agents)", () => {
    expect(isFreeTextModelAgent("hermes")).toBe(true);
    expect(isFreeTextModelAgent("claude")).toBe(false);
    expect(isFreeTextModelAgent("codex")).toBe(false);
  });

  it("offers no static list but has an explicit default model", () => {
    expect(getModelOptions("hermes")).toEqual([]);
    // Hermes is free-text (no dropdown) but Stoa gives it an explicit default so
    // a fresh session launches `hermes -m gpt-5.5` (OpenAI Codex / GPT-5.5).
    expect(getDefaultModelForAgent("hermes")).toBe("gpt-5.5");
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
    expect(resolveModelForAgent("hermes", "")).toBe("gpt-5.5");
    expect(resolveModelForAgent("hermes", null)).toBe("gpt-5.5");
    expect(resolveModelForAgent("hermes", undefined)).toBe("gpt-5.5");
  });

  it("does NOT inherit another agent's static model (the opus 404 bug)", () => {
    // A project's default_model column defaults to "sonnet" (Claude-centric) and
    // can be "opus"/a Codex id. Passing that to Hermes would yield `hermes -m
    // opus` → Anthropic 404 model: opus. resolveModelForAgent must drop a
    // foreign static model and fall back to Hermes's own default instead.
    expect(resolveModelForAgent("hermes", "opus")).toBe("gpt-5.5");
    expect(resolveModelForAgent("hermes", "sonnet")).toBe("gpt-5.5");
    expect(resolveModelForAgent("hermes", "haiku")).toBe("gpt-5.5");
    expect(resolveModelForAgent("hermes", "gpt-5.4")).toBe("gpt-5.5");
    // but a genuine provider-qualified Hermes model still passes through
    expect(resolveModelForAgent("hermes", "anthropic/claude-opus-4.8")).toBe(
      "anthropic/claude-opus-4.8"
    );
  });
});

describe("model catalog — free-text agents (kilo + kimi)", () => {
  it("is flagged free-text", () => {
    expect(isFreeTextModelAgent("kilo")).toBe(true);
    expect(isFreeTextModelAgent("kimi")).toBe(true);
  });

  it("offers no static list and falls back to the agent's own default", () => {
    expect(getModelOptions("kilo")).toEqual([]);
    expect(getModelOptions("kimi")).toEqual([]);
    // Empty model → agent default (empty string means "use the agent's config").
    expect(getDefaultModelForAgent("kilo")).toBe("");
    expect(getDefaultModelForAgent("kimi")).toBe("");
  });

  it("accepts any non-empty model verbatim; empty → the agent default", () => {
    for (const agent of ["kilo", "kimi"] as const) {
      expect(isSupportedModelForAgent(agent, "provider/model-name")).toBe(true);
      expect(isSupportedModelForAgent(agent, "")).toBe(false);
      expect(resolveModelForAgent(agent, "  openai/gpt-5  ")).toBe(
        "openai/gpt-5"
      );
      expect(resolveModelForAgent(agent, "")).toBe("");
      expect(resolveModelForAgent(agent, null)).toBe("");
    }
  });

  it("does NOT inherit another agent's static model", () => {
    for (const agent of ["kilo", "kimi"] as const) {
      expect(resolveModelForAgent(agent, "opus")).toBe("");
      expect(resolveModelForAgent(agent, "sonnet")).toBe("");
      expect(resolveModelForAgent(agent, "gpt-5.4")).toBe("");
      // but a genuine provider-qualified model still passes through
      expect(resolveModelForAgent(agent, "anthropic/claude-opus-4.8")).toBe(
        "anthropic/claude-opus-4.8"
      );
    }
  });
});

describe("nextModelOnAgentChange (model carry-over on agent switch)", () => {
  it("static -> free-text: resets to the free-text agent's default (no leak)", () => {
    // No static model name leaks into Hermes; it resets to Hermes's own default.
    expect(nextModelOnAgentChange("hermes", "sonnet")).toBe("gpt-5.5");
    expect(nextModelOnAgentChange("hermes", "gpt-5.4")).toBe("gpt-5.5");
  });

  it("free-text -> static: drops the free-text value for the static default", () => {
    expect(
      nextModelOnAgentChange("claude", "anthropic/claude-sonnet-4.6")
    ).toBe("sonnet");
  });

  it("static -> static: keeps a valid model, else the new agent's default", () => {
    expect(nextModelOnAgentChange("claude", "opus")).toBe("opus");
    expect(nextModelOnAgentChange("codex", "sonnet")).toBe("gpt-5.5");
  });
});

describe("model catalog — free-text agents (kilo + kimi)", () => {
  it.each(["kilo", "kimi"] as const)(
    "%s: is flagged free-text, has no static list, defaults to empty",
    (agent) => {
      expect(isFreeTextModelAgent(agent)).toBe(true);
      expect(getModelOptions(agent)).toEqual([]);
      expect(getDefaultModelForAgent(agent)).toBe("");
    }
  );

  it.each(["kilo", "kimi"] as const)(
    "%s: accepts any non-empty model verbatim; drops foreign static models",
    (agent) => {
      expect(
        isSupportedModelForAgent(agent, "anthropic/claude-sonnet-4.6")
      ).toBe(true);
      // A static Claude/Codex model must NOT leak in.
      expect(resolveModelForAgent(agent, "opus")).toBe("");
      expect(resolveModelForAgent(agent, "sonnet")).toBe("");
      expect(resolveModelForAgent(agent, "gpt-5.5")).toBe("");
      // A genuine free-text model passes through.
      expect(resolveModelForAgent(agent, "openrouter/x")).toBe("openrouter/x");
      // Empty → agent picks its own default (no model flag).
      expect(resolveModelForAgent(agent, "")).toBe("");
      expect(resolveModelForAgent(agent, null)).toBe("");
    }
  );

  it("nextModelOnAgentChange resets to empty when switching to a free-text agent", () => {
    expect(nextModelOnAgentChange("kilo", "sonnet")).toBe("");
    expect(nextModelOnAgentChange("kimi", "gpt-5.5")).toBe("");
  });
});
