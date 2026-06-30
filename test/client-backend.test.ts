/**
 * buildSpawnForSession (lib/client/backend.ts) — the pty (re)attach spawn params.
 * Regression guard for the MEDIUM bug where a Codex conductor lost its persisted
 * stoa-MCP wiring on re-attach: the spawn must replay session.mcp_launch_args as
 * clean argv (the server path did; this one had drifted).
 */
import { describe, it, expect, vi } from "vitest";
import { buildSpawnForSession } from "@/lib/client/backend";
import type { Session } from "@/lib/db";

// Minimal Session for the spawn builder — only the fields buildSpawnForSession
// reads matter; the rest are filled to satisfy the type.
function session(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    name: "Conductor",
    tmux_name: "codex-s1",
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
    agent_type: "codex",
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

describe("buildSpawnForSession", () => {
  it("replays a Codex conductor's mcp_launch_args as clean argv on re-attach", () => {
    const mcp = [
      "-c",
      "mcp_servers.stoa.command=stoa",
      "-c",
      'mcp_servers.stoa.args=["mcp"]',
    ];
    const { args } = buildSpawnForSession(
      session({ mcp_launch_args: JSON.stringify(mcp) })
    );
    // The conductor tokens land as a contiguous, order-preserving run of discrete
    // argv entries — not just "present somewhere" (reversed pairs would break the
    // -c key/value association).
    const start = args.indexOf("-c");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(args.slice(start, start + mcp.length)).toEqual(mcp);
  });

  it("omits the MCP flags for a non-conductor (null mcp_launch_args)", () => {
    const { args } = buildSpawnForSession(session({ mcp_launch_args: null }));
    expect(args).not.toContain("-c");
  });

  it("survives a malformed mcp_launch_args (spawns without the flags, no throw)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() =>
        buildSpawnForSession(session({ mcp_launch_args: "{not json" }))
      ).not.toThrow();
      const { args } = buildSpawnForSession(
        session({ mcp_launch_args: "{not json" })
      );
      expect(args).not.toContain("-c");
    } finally {
      warn.mockRestore();
    }
  });

  it("a shell session yields an empty spawn", () => {
    const spawn = buildSpawnForSession(session({ agent_type: "shell" }));
    expect(spawn).toEqual({ binary: "", args: [], cwd: "/repo" });
  });

  // #8: a native fork that re-attaches BEFORE its first turn (no own
  // claude_session_id yet) must resume its parent (--resume <parent>
  // --fork-session) instead of respawning blank.
  it("resumes the parent for a not-yet-started native fork when given allSessions", () => {
    const parent = session({ id: "p", claude_session_id: "parent-cid" });
    const fork = session({
      id: "f",
      agent_type: "claude",
      parent_session_id: "p",
      claude_session_id: null,
    });
    const { args } = buildSpawnForSession(fork, {
      allSessions: [parent, fork],
    });
    const i = args.indexOf("--resume");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args.slice(i, i + 2)).toEqual(["--resume", "parent-cid"]);
    expect(args).toContain("--fork-session");
  });

  it("does NOT resume the parent for a non-native (codex) fork", () => {
    const parent = session({ id: "p", claude_session_id: "parent-cid" });
    const fork = session({
      id: "f",
      agent_type: "codex",
      parent_session_id: "p",
      claude_session_id: null,
    });
    const { args } = buildSpawnForSession(fork, {
      allSessions: [parent, fork],
    });
    expect(args).not.toContain("--fork-session");
    expect(args).not.toContain("parent-cid");
  });

  it("an explicit parentSessionId overrides the allSessions self-resolution", () => {
    const fork = session({
      id: "f",
      agent_type: "claude",
      parent_session_id: "p",
      claude_session_id: null,
    });
    const { args } = buildSpawnForSession(fork, {
      parentSessionId: null,
      allSessions: [
        session({ id: "p", claude_session_id: "parent-cid" }),
        fork,
      ],
    });
    expect(args).not.toContain("--fork-session");
  });
});
