/**
 * Regression locks for the multi-repo GitPanel commit-target + selection bugs.
 *
 * B020 — In multi-repo mode `workingDirectory` is the workspace ROOT (a non-git
 * dir); committing against it 400s. `multiRepoCommitTarget` must resolve the
 * commit to the first repo with staged changes (mirroring GitDrawer), falling
 * back to the primary repo path/branch when nothing is staged.
 *
 * B024 — `isFileSelected` must compare a repo-qualified identity in multi-repo
 * mode, so same-named files across different repos don't all highlight together.
 *
 * Both are pure functions → they run on the full ubuntu/macos/windows matrix
 * with no real git.
 */
import { describe, it, expect } from "vitest";
import { multiRepoCommitTarget } from "@/components/GitPanel/index";
import { isFileSelected } from "@/components/GitPanel/FileChanges";
import type {
  MultiRepoGitStatus,
  MultiRepoGitFile,
} from "@/lib/multi-repo-git";

function repo(id: string, name: string, path: string, branch: string) {
  return {
    id,
    name,
    path,
    branch,
    ahead: 0,
    behind: 0,
    isValid: true,
  };
}

function stagedFile(
  repoId: string,
  repoPath: string,
  path: string
): MultiRepoGitFile {
  return {
    path,
    status: "modified",
    staged: true,
    repoId,
    repoName: repoId,
    repoPath,
  };
}

function emptyStatus(repos: ReturnType<typeof repo>[]): MultiRepoGitStatus {
  return { repositories: repos, staged: [], unstaged: [], untracked: [] };
}

describe("B020 — multiRepoCommitTarget resolves the commit to a real repo", () => {
  const primary = repo("p", "primary", "/ws/primary", "main");
  const other = repo("o", "other", "/ws/other", "feat/x");

  it("falls back to the primary repo path/branch when nothing is staged", () => {
    const target = multiRepoCommitTarget(
      emptyStatus([primary, other]),
      "/ws/primary",
      "main"
    );
    // Crucially NOT the workspace root that the caller would otherwise pass.
    expect(target.path).toBe("/ws/primary");
    expect(target.branch).toBe("main");
    expect(target.name).toBeUndefined();
    expect(target.multipleReposStaged).toBe(false);
  });

  it("targets the first repo that actually has staged changes", () => {
    const status = emptyStatus([primary, other]);
    status.staged = [stagedFile("o", "/ws/other", "src/index.ts")];

    const target = multiRepoCommitTarget(status, "/ws/primary", "main");
    expect(target.path).toBe("/ws/other");
    expect(target.branch).toBe("feat/x");
    expect(target.name).toBe("other");
    expect(target.multipleReposStaged).toBe(false);
  });

  it("flags when more than one repo has staged changes (commit-the-first warning)", () => {
    const status = emptyStatus([primary, other]);
    status.staged = [
      stagedFile("p", "/ws/primary", "a.ts"),
      stagedFile("o", "/ws/other", "b.ts"),
    ];

    const target = multiRepoCommitTarget(status, "/ws/primary", "main");
    // Order follows the repositories array, so primary wins as the target.
    expect(target.path).toBe("/ws/primary");
    expect(target.multipleReposStaged).toBe(true);
  });

  it("falls back when status data is missing (null/undefined)", () => {
    expect(multiRepoCommitTarget(null, "/ws/primary", "main").path).toBe(
      "/ws/primary"
    );
    expect(multiRepoCommitTarget(undefined, "/ws/primary", "dev").branch).toBe(
      "dev"
    );
  });
});

describe("B024 — isFileSelected disambiguates same-named files across repos", () => {
  const fileA: MultiRepoGitFile = stagedFile("a", "/ws/a", "src/index.ts");
  const fileB: MultiRepoGitFile = stagedFile("b", "/ws/b", "src/index.ts");

  it("highlights only the file in the selected repo, not its same-named sibling", () => {
    // Selecting a.src/index.ts must NOT light up b.src/index.ts.
    expect(isFileSelected(fileA, "src/index.ts", "/ws/a")).toBe(true);
    expect(isFileSelected(fileB, "src/index.ts", "/ws/a")).toBe(false);
  });

  it("single-repo files (no repoPath) still match on path alone", () => {
    const plain = { path: "a.ts", status: "modified", staged: false } as const;
    expect(isFileSelected(plain, "a.ts", undefined)).toBe(true);
    expect(isFileSelected(plain, "b.ts", undefined)).toBe(false);
  });

  it("nothing selected → never highlighted", () => {
    expect(isFileSelected(fileA, undefined, undefined)).toBe(false);
  });

  it("legacy caller without selectedRepoPath still highlights the path match", () => {
    // Back-compat: if the repo isn't threaded, fall back to path-only behavior.
    expect(isFileSelected(fileA, "src/index.ts", undefined)).toBe(true);
  });
});
