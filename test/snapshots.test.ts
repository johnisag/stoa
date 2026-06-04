import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the git seam so we test snapshot orchestration (ref naming, no-op skip,
// commit-tree parenting), not real git.
const runGit = vi.fn();
const isGitRepo = vi.fn();
vi.mock("../lib/git", () => ({
  runGit: (...a: unknown[]) => runGit(...a),
  isGitRepo: (...a: unknown[]) => isGitRepo(...a),
}));

import {
  captureSnapshot,
  listSnapshots,
  getSnapshotDiff,
} from "../lib/snapshots";

const argStr = (args: string[]) => args.join(" ");

beforeEach(() => {
  runGit.mockReset();
  isGitRepo.mockReset();
});

describe("listSnapshots", () => {
  it("parses for-each-ref output oldest→newest", async () => {
    runGit.mockResolvedValue({
      stdout:
        "000001\tsha1\t2026-01-01T00:00:00Z\tfirst\n" +
        "000002\tsha2\t2026-01-01T00:01:00Z\tsecond turn\n",
      stderr: "",
    });
    expect(await listSnapshots("/repo", "sess")).toEqual([
      { seq: 1, sha: "sha1", date: "2026-01-01T00:00:00Z", summary: "first" },
      {
        seq: 2,
        sha: "sha2",
        date: "2026-01-01T00:01:00Z",
        summary: "second turn",
      },
    ]);
  });

  it("returns [] when the ref namespace can't be read", async () => {
    runGit.mockRejectedValue(new Error("no refs"));
    expect(await listSnapshots("/repo", "sess")).toEqual([]);
  });
});

describe("captureSnapshot", () => {
  it("returns null and runs no git when the cwd isn't a repo", async () => {
    isGitRepo.mockResolvedValue(false);
    expect(await captureSnapshot("/x", "s", "sum")).toBeNull();
    expect(runGit).not.toHaveBeenCalled();
  });

  it("commits the working tree and creates a namespaced, zero-padded ref", async () => {
    isGitRepo.mockResolvedValue(true);
    runGit.mockImplementation(async (_cwd: string, args: string[]) => {
      const a = argStr(args);
      if (a === "write-tree") return { stdout: "tree-sha\n", stderr: "" };
      if (a.startsWith("for-each-ref")) return { stdout: "", stderr: "" };
      if (a === "rev-parse HEAD") return { stdout: "head-sha\n", stderr: "" };
      if (a.startsWith("commit-tree"))
        return { stdout: "commit-sha\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });

    const snap = await captureSnapshot("/repo", "sess", "did a thing");
    expect(snap?.seq).toBe(1);
    expect(snap?.sha).toBe("commit-sha");

    // Initializes the throwaway index before `add -A` (the Windows no-op guard).
    expect(
      runGit.mock.calls.some(
        (c) => (c[1] as string[]).join(" ") === "read-tree --empty"
      )
    ).toBe(true);

    // committed the snapshot tree, parented on HEAD, with the summary subject
    const commit = runGit.mock.calls.find(
      (c) => (c[1] as string[])[0] === "commit-tree"
    );
    expect(commit?.[1]).toEqual([
      "commit-tree",
      "tree-sha",
      "-p",
      "head-sha",
      "-m",
      "did a thing",
    ]);

    // pinned under refs/stoa/snap/<id>/<padded-seq>
    const updateRef = runGit.mock.calls.find(
      (c) => (c[1] as string[])[0] === "update-ref"
    );
    expect(updateRef?.[1]).toEqual([
      "update-ref",
      "refs/stoa/snap/sess/000001",
      "commit-sha",
    ]);
  });

  it("skips a no-op turn whose tree matches the last snapshot", async () => {
    isGitRepo.mockResolvedValue(true);
    runGit.mockImplementation(async (_cwd: string, args: string[]) => {
      const a = argStr(args);
      if (a === "write-tree") return { stdout: "same-tree\n", stderr: "" };
      if (a.startsWith("for-each-ref"))
        return { stdout: "000003\tsha3\t2026\tprev\n", stderr: "" };
      if (a === "rev-parse sha3^{tree}")
        return { stdout: "same-tree\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });

    expect(await captureSnapshot("/repo", "sess", "noop")).toBeNull();
    expect(
      runGit.mock.calls.some((c) => (c[1] as string[])[0] === "commit-tree")
    ).toBe(false);
  });
});

describe("getSnapshotDiff", () => {
  it("diffs the previous snapshot against the selected one", async () => {
    runGit.mockImplementation(async (_cwd: string, args: string[]) => {
      const a = argStr(args);
      if (a.startsWith("for-each-ref"))
        return {
          stdout: "000001\tsha1\td\tone\n000002\tsha2\td\ttwo\n",
          stderr: "",
        };
      if (a === "diff sha1 sha2")
        return { stdout: "diff --git a/f b/f\n+x", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const diff = await getSnapshotDiff("/repo", "sess", 2);
    expect(diff).toContain("+x");
  });

  it("returns empty for an unknown snapshot seq", async () => {
    runGit.mockImplementation(async (_cwd: string, args: string[]) => {
      if (argStr(args).startsWith("for-each-ref"))
        return { stdout: "000001\tsha1\td\tone\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    expect(await getSnapshotDiff("/repo", "sess", 99)).toBe("");
  });

  it("uses diff-tree --root for the first, parentless snapshot", async () => {
    runGit.mockImplementation(async (_cwd: string, args: string[]) => {
      const a = argStr(args);
      if (a.startsWith("for-each-ref"))
        return { stdout: "000001\tsha1\td\tone\n", stderr: "" };
      if (a === "rev-parse sha1^") throw new Error("no parent");
      if (a === "diff-tree -p --root sha1")
        return { stdout: "diff --git a/f b/f\n+root", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    expect(await getSnapshotDiff("/repo", "sess", 1)).toContain("+root");
  });
});
