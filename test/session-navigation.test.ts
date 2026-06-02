import { describe, it, expect } from "vitest";
import { getSwitchableSessionOrder } from "@/lib/session-navigation";
import type { Session } from "@/lib/db";

function mk(id: string, over: Partial<Session> = {}): Session {
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
    ...over,
  };
}

describe("getSwitchableSessionOrder", () => {
  it("excludes conductor workers", () => {
    const sessions = [
      mk("a"),
      mk("w1", { conductor_session_id: "a" }),
      mk("b"),
    ];
    expect(getSwitchableSessionOrder(sessions, [])).toEqual(["a", "b"]);
  });

  it("orders by project, then session list order (projects view)", () => {
    const sessions = [
      mk("a", { project_id: "p2" }),
      mk("b", { project_id: "p1" }),
      mk("c", { project_id: "p1" }),
    ];
    const projects = [{ id: "p1" }, { id: "p2" }];
    // p1 first (b, c in list order), then p2 (a)
    expect(getSwitchableSessionOrder(sessions, projects)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("buckets a null project_id under 'uncategorized'", () => {
    const sessions = [
      mk("a", { project_id: null }),
      mk("b", { project_id: "p1" }),
    ];
    const projects = [{ id: "p1" }, { id: "uncategorized" }];
    expect(getSwitchableSessionOrder(sessions, projects)).toEqual(["b", "a"]);
  });

  it("groups by group_path (first-appearance order) when there are no projects", () => {
    const sessions = [
      mk("a", { group_path: "g2" }),
      mk("b", { group_path: "g1" }),
      mk("c", { group_path: "g2" }),
    ];
    // groups by first appearance: g2 [a, c], then g1 [b]
    expect(getSwitchableSessionOrder(sessions, [])).toEqual(["a", "c", "b"]);
  });

  it("appends sessions whose project_id matches no project (orphans stay reachable)", () => {
    const sessions = [
      mk("a", { project_id: "p1" }),
      mk("orphan", { project_id: "ghost" }),
    ];
    const projects = [{ id: "p1" }];
    expect(getSwitchableSessionOrder(sessions, projects)).toEqual([
      "a",
      "orphan",
    ]);
  });

  it("handles empty / workers-only inputs without duplicates", () => {
    expect(getSwitchableSessionOrder([], [])).toEqual([]);
    const onlyWorkers = [mk("w", { conductor_session_id: "x" })];
    expect(getSwitchableSessionOrder(onlyWorkers, [{ id: "p1" }])).toEqual([]);
  });
});
