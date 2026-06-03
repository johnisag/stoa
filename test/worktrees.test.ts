/**
 * Locks the worktree git invocations to shell-free execFile argv (no
 * `2>/dev/null || echo ""`, no interpolated paths) so they behave identically on
 * Windows — the old shell strings silently no-op'd under cmd.exe, orphaning
 * worktrees. Mocks child_process.execFile (the seam lib/git.ts's runGit uses),
 * so it runs on every OS without a real git binary.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { calls } = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: string[] }>,
}));

vi.mock("child_process", () => ({
  execFile: (cmd: string, args: string[], optsOrCb: unknown, cb?: unknown) => {
    const callback = (typeof optsOrCb === "function" ? optsOrCb : cb) as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void;
    calls.push({ cmd, args });
    let stdout = "";
    if (args.includes("--git-common-dir")) {
      stdout = "/Users/me/proj/.git\n";
    } else if (args.includes("list") && args.includes("--porcelain")) {
      stdout =
        "worktree /Users/me/proj\nHEAD aaa\nbranch refs/heads/main\n\n" +
        "worktree /Users/me/.stoa/worktrees/proj-feat\nHEAD bbb\nbranch refs/heads/feature/feat\n\n";
    } else if (args.includes("--abbrev-ref")) {
      stdout = "feature/feat\n";
    }
    callback(null, { stdout, stderr: "" });
  },
}));

import {
  listWorktrees,
  getMainRepoPath,
  deleteWorktree,
} from "@/lib/worktrees";

const argvOf = (pred: (a: string[]) => boolean) =>
  calls.find((c) => pred(c.args))?.args;

beforeEach(() => {
  calls.length = 0;
});

describe("worktree git invocations — shell-free execFile argv", () => {
  it("every call shells out to bare 'git' with no shell string", async () => {
    await listWorktrees("/Users/me/proj");
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.cmd).toBe("git"); // never a "git -C ... | ..." shell string
      expect(c.args.some((a) => a.includes("2>") || a.includes("||"))).toBe(
        false
      );
    }
  });

  it("listWorktrees uses `worktree list --porcelain` and parses entries", async () => {
    const wts = await listWorktrees("/Users/me/proj");
    expect(argvOf((a) => a[0] === "worktree" && a[1] === "list")).toEqual([
      "worktree",
      "list",
      "--porcelain",
    ]);
    expect(wts).toHaveLength(2);
    expect(wts[1]).toMatchObject({
      path: "/Users/me/.stoa/worktrees/proj-feat",
      branch: "feature/feat",
    });
  });

  it("getMainRepoPath strips the .git segment cross-platform (Windows fix)", async () => {
    const main = await getMainRepoPath("/Users/me/.stoa/worktrees/proj-feat");
    expect(argvOf((a) => a.includes("--git-common-dir"))).toEqual([
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    expect(main).toBe("/Users/me/proj");
  });

  it("deleteWorktree removes via argv and deletes the branch", async () => {
    await deleteWorktree("/Users/me/wt", "/Users/me/proj", true);
    expect(argvOf((a) => a[0] === "worktree" && a[1] === "remove")).toEqual([
      "worktree",
      "remove",
      "/Users/me/wt",
      "--force",
    ]);
    expect(argvOf((a) => a[0] === "branch")).toEqual([
      "branch",
      "-D",
      "feature/feat",
    ]);
  });
});
