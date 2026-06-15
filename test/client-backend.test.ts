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
});
