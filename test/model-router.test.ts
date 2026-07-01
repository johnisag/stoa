import { describe, it, expect } from "vitest";
import { tierIndex, escalateModel, modelForFixRound } from "@/lib/model-router";
import { getModelOptions } from "@/lib/model-catalog";

describe("tierIndex (#20 — the Claude ladder)", () => {
  it("maps aliases AND dated variants into their tier", () => {
    expect(tierIndex("claude", "haiku")).toBe(0);
    expect(tierIndex("claude", "claude-haiku-4-5")).toBe(0);
    expect(tierIndex("claude", "sonnet")).toBe(1);
    expect(tierIndex("claude", "claude-sonnet-4-6")).toBe(1);
    expect(tierIndex("claude", "opus")).toBe(2);
    expect(tierIndex("claude", "claude-opus-4-7")).toBe(2);
  });

  it("returns null for unknown models and for agents without a ladder", () => {
    expect(tierIndex("claude", "gpt-5.5")).toBeNull();
    expect(tierIndex("codex", "gpt-5.5")).toBeNull();
    expect(tierIndex("hermes", "anthropic/claude-opus-4.8")).toBeNull();
  });
});

describe("escalateModel (#20 — one tier up, catalog members only)", () => {
  it("climbs haiku→sonnet→opus and stops at the top", () => {
    expect(escalateModel("claude", "haiku")).toBe("sonnet");
    expect(escalateModel("claude", "claude-haiku-4-5")).toBe("sonnet");
    expect(escalateModel("claude", "sonnet")).toBe("opus");
    expect(escalateModel("claude", "opus")).toBeNull(); // already at the top
    expect(escalateModel("claude", "claude-opus-4-7")).toBeNull();
  });

  it("NEVER escalates free-text agents or unknown models", () => {
    expect(escalateModel("hermes", "anthropic/claude-sonnet-4.6")).toBeNull();
    expect(escalateModel("kilo", "whatever")).toBeNull();
    expect(escalateModel("kimi", "k2")).toBeNull();
    expect(escalateModel("codex", "gpt-5.4-mini")).toBeNull(); // no ladder yet
    expect(escalateModel("claude", "not-a-model")).toBeNull();
  });

  it("only ever returns a member of the agent's static catalog", () => {
    const catalog = getModelOptions("claude").map((o) => o.value);
    for (const base of ["haiku", "sonnet", "claude-haiku-4-5"]) {
      const up = escalateModel("claude", base);
      expect(up).not.toBeNull();
      expect(catalog).toContain(up!);
    }
  });
});

describe("modelForFixRound (#20 — deterministic per-round escalation)", () => {
  it("round 1 runs the base; round ≥2 climbs exactly ONE tier", () => {
    expect(modelForFixRound("claude", "haiku", 1)).toBe("haiku");
    expect(modelForFixRound("claude", "haiku", 2)).toBe("sonnet");
    // deterministic: round 3 does NOT climb again (one tier above base, always)
    expect(modelForFixRound("claude", "haiku", 3)).toBe("sonnet");
  });

  it("falls back to the base when escalation isn't possible", () => {
    expect(modelForFixRound("claude", "opus", 2)).toBe("opus"); // top already
    expect(modelForFixRound("codex", "gpt-5.5", 2)).toBe("gpt-5.5"); // no ladder
  });

  it("null/unknown base resolves to the agent default first", () => {
    // Claude's catalog default is sonnet → round 2 escalates to opus.
    expect(modelForFixRound("claude", null, 1)).toBe("sonnet");
    expect(modelForFixRound("claude", null, 2)).toBe("opus");
    // an unknown base clamps to the default before any climb
    expect(modelForFixRound("claude", "bogus-model", 1)).toBe("sonnet");
  });

  it("free-text agents pass their base through untouched at every round", () => {
    expect(modelForFixRound("hermes", "anthropic/claude-opus-4.8", 2)).toBe(
      "anthropic/claude-opus-4.8"
    );
  });
});
