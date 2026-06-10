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
  // exercise the branch-deletion safety gate. `removeFails` forces `git worktree
  // remove` to error (exercises the rm fallback); `includePrunable` adds a stale
  // registration to the porcelain list (exercises the attach-picker filter).
  state: {
    headBranch: "feature/feat",
    removeFails: false,
    includePrunable: false,
    // fs is mocked too (below): `pathsExist` is what fs.existsSync returns;
    // `rmThrows` makes fs.promises.rm reject with EBUSY (the stuck-lock case).
    pathsExist: false,
    rmThrows: false,
  },
}));

vi.mock("child_process", () => ({
  execFile: (cmd: string, args: string[], optsOrCb: unknown, cb?: unknown) => {
    const callback = (typeof optsOrCb === "function" ? optsOrCb : cb) as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void;
    calls.push({ cmd, args });
    if (state.removeFails && args[0] === "worktree" && args[1] === "remove") {
      callback(new Error("EBUSY: resource busy or locked"), {
        stdout: "",
        stderr: "",
      });
      return;
    }
    let stdout = "";
    if (args.includes("--git-common-dir")) {
      stdout = "/Users/me/proj/.git\n";
    } else if (args.includes("list") && args.includes("--porcelain")) {
      stdout =
        "worktree /Users/me/proj\nHEAD aaa\nbranch refs/heads/main\n\n" +
        "worktree /Users/me/.stoa/worktrees/proj-feat\nHEAD bbb\nbranch refs/heads/feature/feat\n\n";
      if (state.includePrunable) {
        stdout +=
          "worktree /Users/me/.stoa/worktrees/proj-gone\nHEAD ccc\n" +
          "branch refs/heads/feature/gone\n" +
          "prunable gitdir file points to non-existent location\n\n";
      }
    } else if (args.includes("--abbrev-ref")) {
      stdout = `${state.headBranch}\n`;
    }
    callback(null, { stdout, stderr: "" });
  },
}));

// fs is mocked so the worktree existence/rm branches are deterministic on every
// OS (the test paths are fake). Real fs passes through except existsSync (driven
// by `pathsExist`) and promises.rm (rejects with EBUSY when `rmThrows`).
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: () => state.pathsExist,
    promises: {
      ...actual.promises,
      rm: async () => {
        if (state.rmThrows) throw new Error("EBUSY: resource busy or locked");
      },
    },
  };
});

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
  state.removeFails = false;
  state.includePrunable = false;
  state.pathsExist = false;
  state.rmThrows = false;
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
    state.pathsExist = true; // fake paths "exist" on disk
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

  it("listWorktrees drops `prunable` (stale) registrations — attach-picker fix", async () => {
    // The two live entries "exist"; the prunable one is filtered by its flag.
    state.pathsExist = true;
    state.includePrunable = true;
    const wts = await listWorktrees("/Users/me/proj");
    // main + proj-feat survive; the prunable proj-gone is filtered out.
    expect(wts.map((w) => w.path)).toEqual([
      "/Users/me/proj",
      "/Users/me/.stoa/worktrees/proj-feat",
    ]);
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

  it("always prunes stale registrations after removal", async () => {
    await deleteWorktree("/Users/me/wt", "/Users/me/proj", false);
    expect(argvOf((a) => a[0] === "worktree" && a[1] === "prune")).toEqual([
      "worktree",
      "prune",
    ]);
  });

  it("falls back to a manual rm + prune when `git worktree remove` fails (EBUSY)", async () => {
    // The fake path doesn't exist, so the rm fallback resolves and the worktree
    // is considered gone — deleteWorktree must NOT let the EBUSY escape.
    state.removeFails = true;
    await expect(
      deleteWorktree("/Users/me/wt", "/Users/me/proj", false)
    ).resolves.toBeUndefined();
    expect(
      argvOf((a) => a[0] === "worktree" && a[1] === "remove")
    ).toBeDefined();
    expect(
      argvOf((a) => a[0] === "worktree" && a[1] === "prune")
    ).toBeDefined();
  });

  it("throws a clear error (not bare EBUSY) when the dir stays locked", async () => {
    // git remove fails, the manual rm keeps throwing EBUSY, and the dir is still
    // there after every retry → a clear, actionable error rather than a raw EBUSY.
    state.removeFails = true;
    state.pathsExist = true;
    state.rmThrows = true;
    await expect(
      deleteWorktree("/Users/me/wt", "/Users/me/proj", false)
    ).rejects.toThrow(/still locked after \d+ attempts/);
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
