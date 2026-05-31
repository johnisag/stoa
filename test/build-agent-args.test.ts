import { describe, it, expect } from "vitest";
import { buildAgentArgs } from "@/lib/providers";

describe("buildAgentArgs", () => {
  it("claude: plain launch has no args", () => {
    const { binary, args } = buildAgentArgs("claude", {});
    expect(binary).toBe("claude");
    expect(args).toEqual([]);
  });

  it("claude: auto-approve adds the skip-permissions flag", () => {
    const { args } = buildAgentArgs("claude", { autoApprove: true });
    expect(args).toEqual(["--dangerously-skip-permissions"]);
  });

  it("claude: resume splits into discrete argv tokens (no combined string)", () => {
    const { args } = buildAgentArgs("claude", { sessionId: "abc-123" });
    expect(args).toEqual(["--resume", "abc-123"]);
  });

  it("claude: fork from parent adds --fork-session", () => {
    const { args } = buildAgentArgs("claude", { parentSessionId: "parent-9" });
    expect(args).toEqual(["--resume", "parent-9", "--fork-session"]);
  });

  it("claude: initial prompt is a single raw positional arg (no quoting)", () => {
    const prompt = `hello "world" with $pace and 'quotes'`;
    const { args } = buildAgentArgs("claude", { initialPrompt: prompt });
    expect(args).toEqual([prompt]);
    // The prompt must be exactly one argv entry — no shell escaping injected.
    expect(args).toHaveLength(1);
  });

  it("codex: auto-approve flag, model flag, positional prompt", () => {
    const { binary, args } = buildAgentArgs("codex", {
      autoApprove: true,
      model: "o3",
      initialPrompt: "go",
    });
    expect(binary).toBe("codex");
    expect(args).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "o3",
      "go",
    ]);
  });

  it("hermes: --yolo for auto-approve; model/prompt not wired (dynamic models)", () => {
    expect(buildAgentArgs("hermes", {}).args).toEqual([]);
    const { binary, args } = buildAgentArgs("hermes", {
      autoApprove: true,
      model: "opus", // ignored: Hermes models are dynamic, modelFlag unset
      initialPrompt: "ignored until -z semantics confirmed",
    });
    expect(binary).toBe("hermes");
    expect(args).toEqual(["--yolo"]);
  });

  it("shell: empty binary (server spawns a plain shell)", () => {
    const { binary, args } = buildAgentArgs("shell", {});
    expect(binary).toBe("");
    expect(args).toEqual([]);
  });
});
