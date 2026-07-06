import { describe, it, expect, vi } from "vitest";

// F-A regression: the POST /api/sessions/[id]/summarize "fork" path stored the
// original session's agent_type in the DB but then HARDCODED Claude for the
// actual spawn (resolveModelForAgent("claude", …), claudeProvider.buildFlags,
// buildAgentArgs("claude", …), binary "claude"). So forking a non-Claude session
// (e.g. codex/hermes) launched the `claude` CLI under a row claiming to be codex.
// The fix makes buildForkSpawn provider-generic: it spawns the SAME provider as
// the original session, and clamps the stored model to that provider's STATIC
// catalog (getModelOptions) — NOT isSupportedModelForAgent, which a free-text
// agent (hermes) would let pass verbatim into the `-m <model>` spawn token.
//
// Importing the route module evaluates its `next/server`, `@/lib/db` (native
// sqlite binding), and `@/lib/session-backend` (which builds a backend at module
// load, pulling in node-pty) imports, so stub them out — we only exercise the
// pure buildForkSpawn helper.
vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: { json: () => ({}) },
}));
vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  queries: {},
}));
vi.mock("@/lib/session-backend", () => ({
  getSessionBackend: () => ({}),
}));

import { buildForkSpawn } from "@/app/api/sessions/[id]/summarize/route";

describe("F-A — buildForkSpawn (fork spawns the original provider, not claude)", () => {
  it("spawns the CODEX CLI (binary + flags) for a codex fork, never claude", () => {
    const { command, spawn } = buildForkSpawn({
      agentType: "codex",
      model: "gpt-5.4",
      autoApprove: false,
      isRoot: false,
    });
    expect(spawn.binary).toBe("codex");
    expect(spawn.args).toEqual(["--model", "gpt-5.4"]);
    expect(command).toBe("codex --model gpt-5.4");
    // The old bug: any of these would have been claude.
    expect(spawn.binary).not.toBe("claude");
    expect(command).not.toContain("claude");
  });

  it("keeps claude byte-identical (binary, args, command) for a claude fork", () => {
    const { command, spawn } = buildForkSpawn({
      agentType: "claude",
      model: "opus",
      autoApprove: false,
      isRoot: false,
    });
    expect(spawn.binary).toBe("claude");
    expect(spawn.args).toEqual(["--model", "opus"]);
    expect(command).toBe("claude --model opus");
  });

  it("passes the auto-approve flag and (root) IS_SANDBOX prefix on the command string only", () => {
    const { command, spawn } = buildForkSpawn({
      agentType: "claude",
      model: "sonnet",
      autoApprove: true,
      isRoot: true,
    });
    // pty argv stays clean — no env prefix, just the flags.
    expect(spawn.args).toEqual([
      "--dangerously-skip-permissions",
      "--model",
      "sonnet",
    ]);
    // The IS_SANDBOX env prefix rides ONLY the shell command string.
    expect(command).toBe(
      "IS_SANDBOX=1 claude --dangerously-skip-permissions --model sonnet"
    );
  });

  it("does NOT prepend IS_SANDBOX when auto-approve is off, even as root", () => {
    const { command } = buildForkSpawn({
      agentType: "claude",
      model: "sonnet",
      autoApprove: false,
      isRoot: true,
    });
    expect(command.startsWith("IS_SANDBOX=")).toBe(false);
  });

  it("clamps a foreign/non-catalog stored model to the provider default (codex)", () => {
    // "opus" is Claude's catalog, not Codex's — it must not leak into `--model`.
    const { spawn } = buildForkSpawn({
      agentType: "codex",
      model: "opus",
      autoApprove: false,
      isRoot: false,
    });
    expect(spawn.args).toEqual(["--model", "gpt-5.5"]); // codex default, not "opus"
  });

  it("drops a free-text/injection model for a hermes fork (getModelOptions is [])", () => {
    // Hermes accepts ANY string via isSupportedModelForAgent; clamping through
    // getModelOptions (empty for hermes) forces the agent's own default instead,
    // so an injected model can never reach the `-m <model>` spawn token.
    const evil = "x; rm -rf ~";
    const { command, spawn } = buildForkSpawn({
      agentType: "hermes",
      model: evil,
      autoApprove: false,
      isRoot: false,
    });
    expect(spawn.binary).toBe("hermes");
    expect(spawn.args).toEqual(["-m", "gpt-5.5"]); // HERMES_DEFAULT_MODEL
    expect(command).not.toContain(evil);
    expect(command).not.toContain("rm -rf");
  });

  it("spawns the KILO CLI for a kilo fork, dropping a free-text model to the default", () => {
    const { command, spawn } = buildForkSpawn({
      agentType: "kilo",
      model: "evil; rm -rf ~",
      autoApprove: false,
      isRoot: false,
    });
    expect(spawn.binary).toBe("kilo");
    // Kilo has no static catalog, so a free-text model is dropped to the agent
    // default (empty → no --model flag).
    expect(spawn.args).toEqual([]);
    expect(command).toBe("kilo");
    expect(command).not.toContain("rm -rf");
  });

  it("spawns the KIMI CLI for a kimi fork, dropping a free-text model to the default", () => {
    const { command, spawn } = buildForkSpawn({
      agentType: "kimi",
      model: "evil; rm -rf ~",
      autoApprove: false,
      isRoot: false,
    });
    expect(spawn.binary).toBe("kimi");
    // Kimi has no static catalog, so a free-text model is dropped to the agent
    // default (empty → no -m flag).
    expect(spawn.args).toEqual([]);
    expect(command).toBe("kimi");
    expect(command).not.toContain("rm -rf");
  });

  it("passes --yolo for a kimi fork when auto-approve is on (model still dropped)", () => {
    const { spawn } = buildForkSpawn({
      agentType: "kimi",
      model: "kimi-k2",
      autoApprove: true,
      isRoot: false,
    });
    // Kimi has no static catalog, so the free-text model is dropped to the agent
    // default (empty → no -m flag). --yolo is still passed.
    expect(spawn.args).toEqual(["--yolo"]);
  });
});
