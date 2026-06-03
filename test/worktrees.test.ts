/**
 * Locks the worktree git invocations to shell-free execFile argv (no
 * `2>/dev/null || echo ""`, no interpolated paths) so they behave identically on
 * Windows — the old shell strings silently no-op'd under cmd.exe, orphaning
 * worktrees. Mocks child_process.execFile (the seam lib/git.ts's runGit uses),
 * so it runs on every OS without a real git binary.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { calls, state } = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: string[] }>,
  // The branch `rev-parse --abbrev-ref HEAD` reports — varied per test so we can
  // exercise the branch-deletion safety gate.
  state: { headBranch: "feature/feat" },
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
      stdout = `${state.headBranch}\n`;
    }
    callback(null, { stdout, stderr: "" });
  },
}));

import path from "path";
import {
  listWorktrees,
  getMainRepoPath,
  deleteWorktree,
  annotateWorktrees,
  isStoaWorktree,
  getWorktreesDir,
} from "@/lib/worktrees";

const argvOf = (pred: (a: string[]) => boolean) =>
  calls.find((c) => pred(c.args))?.args;

beforeEach(() => {
  calls.length = 0;
  state.headBranch = "feature/feat";
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

  it("does NOT force-delete a branch Stoa didn't create (e.g. develop)", async () => {
    // A worktree manually repointed to a real branch must not lose unmerged
    // commits to `branch -D` on reclaim (F9).
    state.headBranch = "develop";
    await deleteWorktree("/Users/me/wt", "/Users/me/proj", true);
    expect(argvOf((a) => a[0] === "branch")).toBeUndefined();
  });

  it("does NOT delete a non-`main` default branch like trunk", async () => {
    state.headBranch = "trunk";
    await deleteWorktree("/Users/me/wt", "/Users/me/proj", true);
    expect(argvOf((a) => a[0] === "branch")).toBeUndefined();
  });
});

describe("annotateWorktrees — attach-picker join (pure)", () => {
  const stoaWt = path.join(getWorktreesDir(), "proj-feat");
  const mainRepo = "/some/main/repo"; // not under the Stoa worktrees dir

  it("flags Stoa worktrees and ones a live session already owns", () => {
    const out = annotateWorktrees(
      [
        { path: stoaWt, branch: "feature/x", head: "a" },
        { path: mainRepo, branch: "main", head: "b" },
      ],
      [stoaWt] // one live session points at the Stoa worktree
    );
    const by = Object.fromEntries(out.map((w) => [w.path, w]));
    expect(by[stoaWt]).toMatchObject({ isStoa: true, attached: true });
    expect(by[mainRepo]).toMatchObject({ isStoa: false, attached: false });
  });

  it("expands ~ when matching a session's recorded working dir", () => {
    const out = annotateWorktrees(
      [{ path: stoaWt, branch: "x", head: "a" }],
      ["~/.stoa/worktrees/proj-feat"]
    );
    expect(out[0].attached).toBe(true);
  });

  it("an orphaned Stoa worktree (no session) is the attach target", () => {
    const out = annotateWorktrees(
      [{ path: stoaWt, branch: "x", head: "a" }],
      [] // no sessions
    );
    expect(out[0]).toMatchObject({ isStoa: true, attached: false });
  });

  it("isStoaWorktree matches git's forward-slash paths (Windows fix)", () => {
    expect(isStoaWorktree(stoaWt)).toBe(true);
    // git prints forward slashes even on Windows — must still match.
    expect(isStoaWorktree(stoaWt.replace(/\\/g, "/"))).toBe(true);
    expect(isStoaWorktree("/somewhere/else/proj")).toBe(false);
  });

  it("rejects a same-prefixed sibling of the worktrees dir (F4 boundary)", () => {
    // The destructive-delete gate must require a separator boundary, not a bare
    // prefix — else `…/worktrees-evil` would pass and reach rm/branch -D.
    const sibling = getWorktreesDir() + "-evil";
    expect(isStoaWorktree(sibling)).toBe(false);
    expect(isStoaWorktree(path.join(sibling, "x"))).toBe(false);
    // the worktrees dir itself is not a worktree
    expect(isStoaWorktree(getWorktreesDir())).toBe(false);
  });
});
