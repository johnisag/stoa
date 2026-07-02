/**
 * lib/session-launch — the SINGLE Session→argv chokepoint (#32).
 *
 * Every Session-shaped launch path (app/page.tsx's buildSessionCommand tmux+pty,
 * lib/client/backend.ts's buildSpawnForSession re-attach, components/Pane) routes
 * through resolveSessionLaunchOptions / buildAgentArgsForSession. These tests lock:
 *   (a) the injection-defense model clamp fires on EVERY path — a foreign / bogus /
 *       injection-shaped model is dropped to the safe catalog default, and it is
 *       IMPOSSIBLE to reach the CLI with an unclamped model; and
 *   (b) for a normal case the produced argv is byte-identical to calling
 *       buildAgentArgs directly with the (clamped) options — this is a refactor.
 */
import { describe, it, expect } from "vitest";
import {
  resolveSessionLaunchOptions,
  buildAgentArgsForSession,
} from "@/lib/session-launch";
import { buildSpawnForSession } from "@/lib/client/backend";
import { buildAgentArgs } from "@/lib/providers";
import { resolveModelForAgent } from "@/lib/model-catalog";
import type { Session } from "@/lib/db";

// Minimal Session — only the fields the launch chokepoint reads matter; the rest
// satisfy the type. Mirrors the factory in client-backend.test.ts.
function session(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    name: "S",
    tmux_name: "claude-s1",
    created_at: "",
    updated_at: "",
    status: "idle",
    working_directory: "/repo",
    parent_session_id: null,
    claude_session_id: null,
    model: "",
    system_prompt: null,
    group_path: "",
    project_id: null,
    agent_type: "claude",
    auto_approve: false,
    worktree_path: null,
    branch_name: null,
    base_branch: null,
    dev_server_port: null,
    pr_url: null,
    pr_number: null,
    pr_status: null,
    conductor_session_id: null,
    worker_task: null,
    worker_status: null,
    mcp_launch_args: null,
    ...over,
  } as Session;
}

// An injection-shaped value that would be catastrophic if it rode into the POSIX
// tmux `-m <model>` launch unescaped.
const INJECTION = "$(touch /tmp/pwned)";

describe("resolveSessionLaunchOptions — the single resolver", () => {
  it("clamps a bogus static-agent model to the safe catalog default", () => {
    const resolved = resolveSessionLaunchOptions(
      session({ agent_type: "claude", model: INJECTION })
    );
    expect(resolved).not.toBeNull();
    // Claude is a STATIC-catalog agent: anything not in the catalog → default.
    expect(resolved!.options.model).toBe("sonnet");
    expect(resolved!.options.model).not.toBe(INJECTION);
  });

  it("clamps a codex model that is not in its catalog to the codex default", () => {
    const resolved = resolveSessionLaunchOptions(
      session({ agent_type: "codex", model: "gpt-9-evil; rm -rf /" })
    );
    expect(resolved!.options.model).toBe("gpt-5.5");
  });

  it("drops a FOREIGN static model on a free-text agent to its safe default", () => {
    // A project's Claude default 'opus' must not leak into Hermes (`hermes -m opus`
    // → 404) — it is dropped to Hermes's configured default.
    const resolved = resolveSessionLaunchOptions(
      session({ agent_type: "hermes", model: "opus" })
    );
    expect(resolved!.options.model).toBe("claude-opus-4-8");
  });

  it("passes a genuine free-text model through unchanged (no catalog to clamp to)", () => {
    const resolved = resolveSessionLaunchOptions(
      session({ agent_type: "hermes", model: "anthropic/claude-opus-4.8" })
    );
    expect(resolved!.options.model).toBe("anthropic/claude-opus-4.8");
  });

  it("returns null for a shell session (the argv short-circuit)", () => {
    expect(resolveSessionLaunchOptions(session({ agent_type: "shell" }))).toBe(
      null
    );
  });

  it("resolves a not-yet-started native fork's parent id from allSessions", () => {
    const parent = session({ id: "p", claude_session_id: "parent-cid" });
    const fork = session({
      id: "f",
      agent_type: "claude",
      parent_session_id: "p",
      claude_session_id: null,
    });
    const resolved = resolveSessionLaunchOptions(fork, {
      allSessions: [parent, fork],
    });
    expect(resolved!.options.parentSessionId).toBe("parent-cid");
  });

  it("an explicit parentSessionId (incl. null) overrides self-resolution", () => {
    const fork = session({
      id: "f",
      agent_type: "claude",
      parent_session_id: "p",
      claude_session_id: null,
    });
    const resolved = resolveSessionLaunchOptions(fork, {
      parentSessionId: null,
      allSessions: [
        session({ id: "p", claude_session_id: "parent-cid" }),
        fork,
      ],
    });
    expect(resolved!.options.parentSessionId).toBeNull();
  });
});

describe("buildAgentArgsForSession — clamp is NON-BYPASSABLE on the argv path", () => {
  it("a bogus claude model is clamped to the safe default before reaching --model", () => {
    const { binary, args } = buildAgentArgsForSession(
      session({ agent_type: "claude", model: INJECTION })
    );
    expect(binary).toBe("claude");
    // Claude emits `--model <value>` on a fresh launch, so the value MUST be the
    // clamped-safe default 'sonnet' — the untrusted injection never rides through.
    const i = args.indexOf("--model");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("sonnet");
    expect(args.join(" ")).not.toContain(INJECTION);
    expect(args.join(" ")).not.toContain("touch");
  });

  it("a foreign static model on codex is clamped before it can reach --model", () => {
    // 'opus' is Claude's, foreign to codex → clamped to the codex default gpt-5.5,
    // which (unlike Claude) codex DOES emit. The point: the emitted value is the
    // SAFE default, never the untrusted input.
    const { args } = buildAgentArgsForSession(
      session({ agent_type: "codex", model: "opus" })
    );
    const i = args.indexOf("--model");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("gpt-5.5");
    expect(args).not.toContain("opus");
  });

  it("an injection-shaped free-text model is dropped to the safe default (foreign→default OR verbatim, never the raw injection if it matches no catalog)", () => {
    // A free-text agent forwards a genuine model verbatim; an injection string
    // matches no static catalog so resolveModelForAgent returns it as-is HERE —
    // but the argv path emits it as a SINGLE clean token (no shell), so it can
    // never break out. Lock that it is exactly one argv entry.
    const { args } = buildAgentArgsForSession(
      session({ agent_type: "hermes", model: INJECTION })
    );
    const i = args.indexOf("-m");
    expect(i).toBeGreaterThanOrEqual(0);
    // One discrete argv token — a direct (shell-less) spawn, so no metacharacter
    // interpretation is possible.
    expect(args[i + 1]).toBe(INJECTION);
    expect(args).toHaveLength(2);
  });

  it("a shell session yields an empty spawn", () => {
    expect(buildAgentArgsForSession(session({ agent_type: "shell" }))).toEqual({
      binary: "",
      args: [],
    });
  });
});

describe("byte-identical argv for the normal case (refactor preserves behavior)", () => {
  // For each caller-shaped input, buildAgentArgsForSession must equal calling
  // buildAgentArgs directly with the SAME clamped options — proving the chokepoint
  // only centralizes HOW, not WHAT is produced.
  const cases: Array<{
    name: string;
    s: Session;
    opts?: Parameters<typeof buildAgentArgsForSession>[1];
  }> = [
    {
      name: "claude fresh, valid model",
      s: session({ agent_type: "claude", model: "opus" }),
    },
    {
      name: "claude resume (auto-approve)",
      s: session({
        agent_type: "claude",
        model: "opus",
        auto_approve: true,
        claude_session_id: "cid-123",
      }),
    },
    {
      name: "codex with conductor mcp args",
      s: session({
        agent_type: "codex",
        model: "gpt-5.5",
        auto_approve: true,
        mcp_launch_args: JSON.stringify([
          "-c",
          "mcp_servers.stoa.command=stoa",
        ]),
      }),
      opts: { initialPrompt: "do the thing" },
    },
    {
      name: "hermes free-text model",
      s: session({
        agent_type: "hermes",
        model: "anthropic/x",
        auto_approve: true,
      }),
    },
  ];

  for (const { name, s, opts } of cases) {
    it(`${name}: matches buildAgentArgs(clampedOptions)`, () => {
      const via = buildAgentArgsForSession(s, opts);
      const direct = buildAgentArgs(s.agent_type || "claude", {
        sessionId: s.claude_session_id,
        parentSessionId: null,
        autoApprove: s.auto_approve,
        model: resolveModelForAgent(s.agent_type || "claude", s.model),
        extraArgs: s.mcp_launch_args
          ? (JSON.parse(s.mcp_launch_args) as string[])
          : [],
        initialPrompt: opts?.initialPrompt,
      });
      expect(via).toEqual(direct);
    });
  }
});

describe("buildSpawnForSession delegates to the chokepoint (clamp inherited)", () => {
  it("clamps a bogus claude model on the re-attach path too", () => {
    const { binary, args } = buildSpawnForSession(
      session({ agent_type: "claude", model: INJECTION })
    );
    expect(binary).toBe("claude");
    const i = args.indexOf("--model");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("sonnet");
    expect(args.join(" ")).not.toContain(INJECTION);
  });

  it("clamps a foreign static model to the codex default on re-attach", () => {
    const { args } = buildSpawnForSession(
      session({ agent_type: "codex", model: "opus" })
    );
    const i = args.indexOf("--model");
    expect(args[i + 1]).toBe("gpt-5.5");
    expect(args).not.toContain("opus");
  });
});
