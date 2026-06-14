/**
 * Regression for B005 — planner liveness was resolved against the human DISPLAY
 * name (`stoa-plan-<hex>`) while the session backend's `list()` returns BACKEND keys
 * (`<provider>-<uuid>` / `tmux_name`). The two never match, so `alive` was ALWAYS
 * false and a just-spawned planner was reported `failed` whenever PLAN.md wasn't
 * readable yet. The fix resolves liveness via the session row's `tmux_name`
 * (mirroring maintainer.readSurveyRun); this locks that pure rule.
 */
import { describe, it, expect } from "vitest";
import { isPlanSessionAlive } from "../lib/dispatch/planner";
import type { Session } from "../lib/db";

// A minimal Session row — only the fields the liveness check reads matter; the rest
// are filled to satisfy the type.
const session = (over: Partial<Session> = {}): Session =>
  ({
    id: "00000000-0000-0000-0000-000000000001",
    name: "stoa-plan-abcd1234", // the human DISPLAY name
    tmux_name: "claude-00000000-0000-0000-0000-000000000001", // the BACKEND key
    created_at: "2026-06-14T00:00:00Z",
    updated_at: "2026-06-14T00:00:00Z",
    status: "running",
    working_directory: "/tmp/wt",
    parent_session_id: null,
    claude_session_id: null,
    model: "",
    system_prompt: null,
    group_path: "",
    project_id: null,
    agent_type: "claude",
    auto_approve: false,
    worktree_path: "/tmp/wt",
    branch_name: null,
    base_branch: "main",
    dev_server_port: null,
    pr_url: null,
    pr_number: null,
    ...over,
  }) as Session;

describe("isPlanSessionAlive (B005 — liveness via tmux_name, not the display name)", () => {
  it("is ALIVE when the backend list contains the session's tmux_name", () => {
    const s = session();
    const names = new Set([s.tmux_name]);
    expect(isPlanSessionAlive(names, s)).toBe(true);
  });

  it("THE REGRESSION: the backend never lists the display name — that must NOT mark a live planner dead", () => {
    // The pre-fix code did `backend.list().includes(run.sessionName)`. The backend
    // returns tmux_name keys, so a list that legitimately contains the LIVE session
    // (keyed by tmux_name) would have been judged dead because it doesn't contain
    // the display name. Assert the fix keys off tmux_name so this case is ALIVE.
    const s = session();
    const backendNames = new Set([s.tmux_name]); // what list() actually returns
    expect(backendNames.has(s.name)).toBe(false); // display name is never present
    expect(isPlanSessionAlive(backendNames, s)).toBe(true); // still correctly alive
  });

  it("is DEAD when the backend list does not contain the tmux_name", () => {
    const s = session();
    expect(isPlanSessionAlive(new Set(["some-other-key"]), s)).toBe(false);
    expect(isPlanSessionAlive(new Set(), s)).toBe(false);
  });

  it("is DEAD (not a crash) when the session row is missing", () => {
    expect(isPlanSessionAlive(new Set(["anything"]), undefined)).toBe(false);
  });
});
