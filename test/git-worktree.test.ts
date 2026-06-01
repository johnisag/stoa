import { describe, it, expect } from "vitest";
import {
  parseWorktreeList,
  findBaseWorktree,
  type WorktreeInfo,
} from "@/lib/git-status";

const wt = (
  path: string,
  branch: string | null,
  bare = false
): WorktreeInfo => ({
  path,
  branch,
  bare,
});

describe("parseWorktreeList", () => {
  it("parses the main worktree first, then linked worktrees", () => {
    const out = [
      "worktree /home/u/proj",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/multisports-analysis",
      "",
      "worktree /home/u/.stoa/worktrees/happy-stone",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/happy-stone",
      "",
    ].join("\n");
    const list = parseWorktreeList(out);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      path: "/home/u/proj",
      branch: "multisports-analysis",
      bare: false,
    });
    expect(list[1]).toEqual({
      path: "/home/u/.stoa/worktrees/happy-stone",
      branch: "happy-stone",
      bare: false,
    });
  });

  it("marks detached worktrees with a null branch", () => {
    const out = [
      "worktree /home/u/proj",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /home/u/detached",
      "HEAD 3333333333333333333333333333333333333333",
      "detached",
      "",
    ].join("\n");
    const list = parseWorktreeList(out);
    expect(list[1]).toEqual({
      path: "/home/u/detached",
      branch: null,
      bare: false,
    });
  });

  it("marks a bare entry", () => {
    const out = ["worktree /home/u/bare.git", "bare", ""].join("\n");
    const list = parseWorktreeList(out);
    expect(list[0].bare).toBe(true);
    expect(list[0].branch).toBeNull();
  });

  it("tolerates CRLF line endings and a missing trailing blank line", () => {
    const out =
      "worktree /home/u/proj\r\nHEAD abc\r\nbranch refs/heads/main\r\n" +
      "\r\nworktree /home/u/wt\r\nHEAD def\r\nbranch refs/heads/feat";
    const list = parseWorktreeList(out);
    expect(list.map((w) => w.path)).toEqual(["/home/u/proj", "/home/u/wt"]);
    expect(list.map((w) => w.branch)).toEqual(["main", "feat"]);
  });

  it("returns [] for empty output", () => {
    expect(parseWorktreeList("")).toEqual([]);
    expect(parseWorktreeList("\n\n")).toEqual([]);
  });
});

describe("findBaseWorktree", () => {
  const main = wt("/home/u/proj", "main");
  const linked = wt("/home/u/.stoa/worktrees/happy-stone", "happy-stone");

  it("returns null when only the main worktree exists", () => {
    expect(findBaseWorktree([main], "/home/u/proj")).toBeNull();
  });

  it("returns the main worktree when current dir is a different linked one", () => {
    expect(findBaseWorktree([main, linked], linked.path)).toEqual(main);
  });

  it("returns null when the current dir IS the main worktree", () => {
    expect(findBaseWorktree([main, linked], "/home/u/proj")).toBeNull();
  });

  it("matches the main path despite a trailing separator", () => {
    expect(findBaseWorktree([main, linked], "/home/u/proj/")).toBeNull();
  });

  it("does not treat a sibling-prefixed path as the main worktree", () => {
    // current dir shares a prefix with main ("proj" vs "proj-2") but isn't it
    const cur = wt("/home/u/proj-2", "feat");
    expect(findBaseWorktree([main, cur], cur.path)).toEqual(main);
  });

  it("skips a bare entry and uses the first non-bare as main", () => {
    const bare = wt("/home/u/proj.git", null, true);
    expect(findBaseWorktree([bare, main, linked], linked.path)).toEqual(main);
  });
});
