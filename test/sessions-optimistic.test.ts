import { describe, it, expect } from "vitest";
import {
  removeSessionFromCache,
  patchSessionInCache,
  type SessionsCache,
} from "@/data/sessions/optimistic";
import type { Session } from "@/lib/db";

function mkSession(id: string, over: Partial<Session> = {}): Session {
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
    ...over,
  };
}

const cache = (sessions: Session[]): SessionsCache => ({
  sessions,
  groups: [],
});

describe("removeSessionFromCache", () => {
  it("drops only the matching session and keeps the rest", () => {
    const data = cache([mkSession("a"), mkSession("b"), mkSession("c")]);
    const next = removeSessionFromCache(data, "b");
    expect(next?.sessions.map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("is a no-op when the id is absent", () => {
    const data = cache([mkSession("a")]);
    expect(removeSessionFromCache(data, "zzz")?.sessions).toHaveLength(1);
  });

  it("passes undefined through (query still loading)", () => {
    expect(removeSessionFromCache(undefined, "a")).toBeUndefined();
  });

  it("does not mutate the input array", () => {
    const data = cache([mkSession("a"), mkSession("b")]);
    removeSessionFromCache(data, "a");
    expect(data.sessions).toHaveLength(2);
  });

  it("preserves the groups array reference unchanged", () => {
    const data = cache([mkSession("a")]);
    expect(removeSessionFromCache(data, "a")?.groups).toBe(data.groups);
  });
});

describe("patchSessionInCache", () => {
  it("patches only the target session's fields", () => {
    const data = cache([
      mkSession("a", { group_path: "sessions" }),
      mkSession("b", { group_path: "sessions" }),
    ]);
    const next = patchSessionInCache(data, "b", { group_path: "work/api" });
    expect(next?.sessions.find((s) => s.id === "a")?.group_path).toBe(
      "sessions"
    );
    expect(next?.sessions.find((s) => s.id === "b")?.group_path).toBe(
      "work/api"
    );
  });

  it("applies a project_id move", () => {
    const data = cache([mkSession("a", { project_id: null })]);
    const next = patchSessionInCache(data, "a", { project_id: "proj-1" });
    expect(next?.sessions[0].project_id).toBe("proj-1");
  });

  it("passes undefined through", () => {
    expect(patchSessionInCache(undefined, "a", { name: "x" })).toBeUndefined();
  });

  it("does not mutate the original session object", () => {
    const orig = mkSession("a", { name: "old" });
    const data = cache([orig]);
    patchSessionInCache(data, "a", { name: "new" });
    expect(orig.name).toBe("old");
  });
});
