import { describe, it, expect } from "vitest";
import { fuzzyScore, scoreSession, searchSessions } from "@/lib/session-search";
import type { Session } from "@/lib/db";

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    name: "Session One",
    tmux_name: "claude-s1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    status: "idle",
    working_directory: "/work/proj",
    parent_session_id: null,
    claude_session_id: null,
    model: "opus",
    system_prompt: null,
    group_path: "sessions", // the real schema/migration default (not "")
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

describe("fuzzyScore", () => {
  it("returns 0 for an empty query and null for empty text", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("abc", "")).toBeNull();
  });

  it("returns null when the query is not an in-order subsequence", () => {
    expect(fuzzyScore("xyz", "abc")).toBeNull();
    expect(fuzzyScore("cba", "abc")).toBeNull(); // order matters
    expect(fuzzyScore("abcd", "abc")).toBeNull(); // longer than text
  });

  it("matches a subsequence case-insensitively", () => {
    expect(fuzzyScore("AB", "axxxb")).toBeGreaterThan(0);
    expect(fuzzyScore("foo", "FooBar")).toBeGreaterThan(0);
  });

  it("ranks exact >= prefix > scattered", () => {
    const exact = fuzzyScore("abc", "abc")!;
    const prefix = fuzzyScore("abc", "abcdef")!;
    const scattered = fuzzyScore("abc", "axbxc")!;
    expect(exact).toBeGreaterThanOrEqual(prefix);
    expect(prefix).toBeGreaterThan(scattered);
  });

  it("rewards a word-boundary match over a mid-word one", () => {
    expect(fuzzyScore("fb", "foo-bar")!).toBeGreaterThan(
      fuzzyScore("fb", "foobar")!
    );
  });
});

describe("scoreSession", () => {
  it("returns 0 for an empty/whitespace query", () => {
    expect(scoreSession("", mkSession())).toBe(0);
    expect(scoreSession("   ", mkSession())).toBe(0);
  });

  it("matches across name, path, agent, and branch", () => {
    expect(scoreSession("one", mkSession())).not.toBeNull(); // name
    expect(scoreSession("proj", mkSession())).not.toBeNull(); // path/basename
    expect(scoreSession("claude", mkSession())).not.toBeNull(); // agent
    expect(
      scoreSession("feat", mkSession({ branch_name: "feature/x" }))
    ).not.toBeNull(); // branch
  });

  it("trims the query so a stray leading/trailing space doesn't drop matches", () => {
    expect(scoreSession("one ", mkSession())).not.toBeNull();
    expect(scoreSession("  proj  ", mkSession())).not.toBeNull();
  });

  it("does NOT search the deprecated group_path (its 'sessions' default would match everything)", () => {
    // group_path defaults to the literal "sessions"; "sin" is a subsequence of
    // it but appears in none of this session's actually-searched fields.
    const s = mkSession({
      id: "z",
      name: "zebra",
      working_directory: "/code/api",
      agent_type: "codex",
      group_path: "sessions",
    });
    expect(scoreSession("sin", s)).toBeNull();
    expect(searchSessions([s], "sin")).toEqual([]);
  });

  it("returns null when nothing matches", () => {
    expect(scoreSession("zzzzz", mkSession())).toBeNull();
  });
});

describe("searchSessions", () => {
  const a = mkSession({ id: "a", name: "alpha api", updated_at: "2026-01-01" });
  const b = mkSession({
    id: "b",
    name: "beta build",
    updated_at: "2026-02-01",
  });
  const c = mkSession({ id: "c", name: "gamma", updated_at: "2026-03-01" });

  it("returns the input order unchanged for an empty query", () => {
    expect(searchSessions([a, b, c], "").map((s) => s.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(searchSessions([a, b, c], "   ").map((s) => s.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("drops non-matches and ranks the best match first", () => {
    // "alp" is a tight prefix of alpha; gamma never matches.
    const ids = searchSessions([c, b, a], "alp").map((s) => s.id);
    expect(ids).toEqual(["a"]);
  });

  it("breaks score ties by most-recently-updated", () => {
    // "a" appears as a subsequence in all three names; equal-ish matches should
    // fall back to updated_at desc -> c, b, a.
    const x = mkSession({ id: "x", name: "aaa", updated_at: "2026-01-01" });
    const y = mkSession({ id: "y", name: "aaa", updated_at: "2026-05-01" });
    const ids = searchSessions([x, y], "aaa").map((s) => s.id);
    expect(ids).toEqual(["y", "x"]);
  });

  it("does not mutate the input array", () => {
    const input = [c, b, a];
    const snapshot = input.map((s) => s.id);
    searchSessions(input, "a");
    expect(input.map((s) => s.id)).toEqual(snapshot);
  });
});
