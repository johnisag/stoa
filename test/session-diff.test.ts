import { describe, it, expect, vi, beforeEach } from "vitest";
import { devNull } from "os";

// Mock the git seam so we test getSessionDiff's orchestration (base resolution,
// tracked + untracked assembly), not real git.
const runGit = vi.fn();
const isGitRepo = vi.fn();
vi.mock("../lib/git", () => ({
  runGit: (...args: unknown[]) => runGit(...args),
  isGitRepo: (...args: unknown[]) => isGitRepo(...args),
}));

import { getSessionDiff } from "../lib/session-diff";

beforeEach(() => {
  runGit.mockReset();
  isGitRepo.mockReset();
});

describe("getSessionDiff", () => {
  it("reports unsupported (and runs no git) when the cwd isn't a repo", async () => {
    isGitRepo.mockResolvedValue(false);
    const res = await getSessionDiff({
      cwd: "/not/a/repo",
      baseBranch: "main",
    });
    expect(res).toEqual({ supported: false, baseRef: null, diff: "" });
    expect(runGit).not.toHaveBeenCalled();
  });

  it("diffs against the MERGE-BASE of the base branch, not its tip", async () => {
    isGitRepo.mockResolvedValue(true);
    runGit.mockImplementation(async (_cwd: string, args: string[]) => {
      const a = args.join(" ");
      if (a.startsWith("rev-parse --verify"))
        return { stdout: "abc\n", stderr: "" };
      if (a === "merge-base main HEAD")
        return { stdout: "base-sha\n", stderr: "" };
      if (a === "diff base-sha")
        return { stdout: "diff --git a/x b/x\n+tracked", stderr: "" };
      if (a.startsWith("ls-files")) return { stdout: "", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const res = await getSessionDiff({ cwd: "/repo", baseBranch: "main" });
    expect(res.supported).toBe(true);
    expect(res.baseRef).toBe("main"); // human label stays the branch
    expect(res.diff).toContain("+tracked");
    // It diffed the merge-base SHA, never the bare base tip.
    expect(
      runGit.mock.calls.some(
        (c) => (c[1] as string[]).join(" ") === "diff base-sha"
      )
    ).toBe(true);
    expect(
      runGit.mock.calls.some(
        (c) => (c[1] as string[]).join(" ") === "diff main"
      )
    ).toBe(false);
  });

  it("falls back to HEAD when the base branch doesn't exist", async () => {
    isGitRepo.mockResolvedValue(true);
    runGit.mockImplementation(async (_cwd: string, args: string[]) => {
      const a = args.join(" ");
      if (a.startsWith("rev-parse --verify")) throw new Error("unknown rev");
      if (a === "diff HEAD")
        return { stdout: "diff --git a/y b/y\n+head", stderr: "" };
      if (a.startsWith("ls-files")) return { stdout: "", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const res = await getSessionDiff({ cwd: "/repo", baseBranch: "gone" });
    expect(res.baseRef).toBe("HEAD");
    expect(res.diff).toContain("+head");
  });

  it("uses HEAD directly when no base branch is given", async () => {
    isGitRepo.mockResolvedValue(true);
    runGit.mockImplementation(async (_cwd: string, args: string[]) => {
      const a = args.join(" ");
      if (a === "diff HEAD")
        return { stdout: "diff --git a/z b/z\n+wip", stderr: "" };
      if (a.startsWith("ls-files")) return { stdout: "", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const res = await getSessionDiff({ cwd: "/repo", baseBranch: null });
    expect(res.baseRef).toBe("HEAD");
    // No base given → no rev-parse verify call.
    expect(
      runGit.mock.calls.some((c) => (c[1] as string[])[0] === "rev-parse")
    ).toBe(false);
    expect(res.diff).toContain("+wip");
  });

  it("appends untracked files, reading the diff off a --no-index exit-1 error", async () => {
    isGitRepo.mockResolvedValue(true);
    runGit.mockImplementation(async (_cwd: string, args: string[]) => {
      const a = args.join(" ");
      if (a === "diff HEAD") return { stdout: "", stderr: "" };
      if (a.startsWith("ls-files")) return { stdout: "new.txt\n", stderr: "" };
      if (a.startsWith("diff --no-index")) {
        // git diff --no-index exits non-zero when files differ; diff is on stdout.
        throw Object.assign(new Error("exit 1"), {
          stdout: "diff --git a/new.txt b/new.txt\n+brand new",
        });
      }
      return { stdout: "", stderr: "" };
    });
    const res = await getSessionDiff({ cwd: "/repo", baseBranch: null });
    expect(res.diff).toContain("+brand new");
    expect(res.diff).toContain("diff --git a/new.txt");
    // Cross-platform null device (NUL on Windows), never a hardcoded /dev/null.
    const noIndex = runGit.mock.calls.find((c) =>
      (c[1] as string[]).includes("--no-index")
    );
    expect(noIndex?.[1]).toEqual(["diff", "--no-index", devNull, "new.txt"]);
  });
});
