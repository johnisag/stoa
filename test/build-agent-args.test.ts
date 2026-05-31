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

  it("hermes: --yolo + free-text model via -m; prompt still not wired", () => {
    expect(buildAgentArgs("hermes", {}).args).toEqual([]);
    const { binary, args } = buildAgentArgs("hermes", {
      autoApprove: true,
      model: "anthropic/claude-sonnet-4.6", // dynamic/free-text → passed via -m
      initialPrompt: "ignored until -z semantics confirmed",
    });
    expect(binary).toBe("hermes");
    expect(args).toEqual(["--yolo", "-m", "anthropic/claude-sonnet-4.6"]);
    // empty model must not append -m (Hermes falls back to its own default)
    expect(
      buildAgentArgs("hermes", { autoApprove: true, model: "" }).args
    ).toEqual(["--yolo"]);
  });

  it("hermes: resume passes --resume <id> as discrete tokens (banner-captured id)", () => {
    const sid = "20260531_133925_98d9fc";
    expect(buildAgentArgs("hermes", { sessionId: sid }).args).toEqual([
      "--resume",
      sid,
    ]);
    // flag ordering with auto-approve
    expect(
      buildAgentArgs("hermes", { autoApprove: true, sessionId: sid }).args
    ).toEqual(["--yolo", "--resume", sid]);
    // best-effort: a falsy/empty id must not append --resume (mustn't break spawn)
    expect(buildAgentArgs("hermes", { sessionId: "" }).args).toEqual([]);
    expect(buildAgentArgs("hermes", { sessionId: null }).args).toEqual([]);
    // Hermes has no --fork-session: a parentSessionId resumes but never forks
    expect(buildAgentArgs("hermes", { parentSessionId: sid }).args).toEqual([
      "--resume",
      sid,
    ]);
  });

  it("shell: empty binary (server spawns a plain shell)", () => {
    const { binary, args } = buildAgentArgs("shell", {});
    expect(binary).toBe("");
    expect(args).toEqual([]);
  });
});
