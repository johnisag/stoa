import { describe, it, expect } from "vitest";
import {
  needsAttention,
  countNeedsAttention,
  nextAttentionSessionId,
  type SessionStatusValue,
} from "@/lib/session-attention";
import type { Session } from "@/lib/db";

function mkSession(id: string): Session {
  return {
    id,
    name: id,
    tmux_name: `claude-${id}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    status: "idle",
    working_directory: "/w",
    parent_session_id: null,
    claude_session_id: null,
    model: "opus",
    system_prompt: null,
    group_path: "sessions",
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
  };
}

const statuses = (m: Record<string, SessionStatusValue>) =>
  Object.fromEntries(Object.entries(m).map(([k, status]) => [k, { status }]));

describe("needsAttention", () => {
  it("is true only for waiting and error", () => {
    expect(needsAttention("waiting")).toBe(true);
    expect(needsAttention("error")).toBe(true);
    expect(needsAttention("running")).toBe(false);
    expect(needsAttention("idle")).toBe(false);
    expect(needsAttention("dead")).toBe(false);
    expect(needsAttention(undefined)).toBe(false);
  });
});

describe("countNeedsAttention", () => {
  const sessions = ["a", "b", "c", "d"].map((id) => mkSession(id));

  it("counts sessions whose status is waiting or error, ignoring others", () => {
    const st = statuses({ a: "waiting", b: "running", c: "error", d: "idle" });
    expect(countNeedsAttention(sessions, st)).toBe(2);
    expect(countNeedsAttention(sessions, {})).toBe(0);
    expect(countNeedsAttention([], st)).toBe(0);
    expect(countNeedsAttention(sessions, undefined)).toBe(0);
  });

  it("counts only statuses backed by a session in the list (no orphans)", () => {
    // "c" (error) has a status entry but no session row -> not counted, so the
    // badge can't exceed what the jump can reach.
    const st = statuses({ a: "waiting", c: "error" });
    expect(countNeedsAttention([mkSession("a")], st)).toBe(1);
  });
});

describe("nextAttentionSessionId", () => {
  const sessions = ["a", "b", "c", "d"].map(mkSession);

  it("returns null when nothing needs attention", () => {
    expect(
      nextAttentionSessionId(
        sessions,
        statuses({ a: "idle", b: "running" }),
        "a"
      )
    ).toBeNull();
  });

  it("returns the next attention session after current, wrapping", () => {
    const st = statuses({ a: "idle", b: "waiting", c: "running", d: "error" });
    // current "b" (an attention session) -> next attention is "d"
    expect(nextAttentionSessionId(sessions, st, "b")).toBe("d");
    // current "d" (last attention) -> wraps to "b"
    expect(nextAttentionSessionId(sessions, st, "d")).toBe("b");
  });

  it("starts at the first attention session when current is outside the set", () => {
    const st = statuses({ a: "idle", b: "waiting", d: "error" });
    expect(nextAttentionSessionId(sessions, st, "a")).toBe("b"); // current not attention
    expect(nextAttentionSessionId(sessions, st, null)).toBe("b"); // no current
    expect(nextAttentionSessionId(sessions, st, "zzz")).toBe("b"); // unknown
  });
});
