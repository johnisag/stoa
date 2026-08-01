import { beforeEach, describe, expect, it, vi } from "vitest";

const runGit = vi.fn();
vi.mock("../lib/git", () => ({
  runGit: (...args: unknown[]) => runGit(...args),
}));

import {
  UNKNOWN_FLEET_PATH_CLAIM,
  classifySensitiveFleetPath,
  collectFleetGitState,
  compareFleetPathClaims,
  normalizeFleetGitPath,
} from "../lib/fleet/git-state";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

function gitResult(stdout: string): { stdout: string; stderr: string } {
  return { stdout, stderr: "" };
}

function installGitFixture(overrides?: {
  mergeBase?: string;
  headSha?: string;
  committed?: string;
  numstat?: string;
  staged?: string;
  unstaged?: string;
  untracked?: string;
}): void {
  runGit.mockImplementation(async (_cwd: string, args: string[]) => {
    if (args.join(" ") === "rev-parse --is-inside-work-tree") {
      return gitResult("true\n");
    }
    if (args.join(" ") === "rev-parse --show-toplevel") {
      return gitResult("C:/work/repo\n");
    }
    if (args.includes(`${BASE_SHA}^{commit}`))
      return gitResult(`${BASE_SHA}\n`);
    if (args.includes("HEAD^{commit}")) {
      return gitResult(`${overrides?.headSha ?? HEAD_SHA}\n`);
    }
    if (args[0] === "merge-base") {
      return gitResult(`${overrides?.mergeBase ?? BASE_SHA}\n`);
    }
    if (args.join(" ") === "rev-parse --abbrev-ref HEAD") {
      return gitResult("feature/fleet-worker\n");
    }
    if (args[0] === "diff" && args.includes("--numstat")) {
      return gitResult(overrides?.numstat ?? "");
    }
    if (args[0] === "diff" && args.includes("--cached")) {
      return gitResult(overrides?.staged ?? "");
    }
    if (
      args[0] === "diff" &&
      args.includes("--name-status") &&
      args.includes(BASE_SHA)
    ) {
      return gitResult(overrides?.committed ?? "");
    }
    if (args[0] === "diff" && args.includes("--name-status")) {
      return gitResult(overrides?.unstaged ?? "");
    }
    if (args[0] === "ls-files") {
      return gitResult(overrides?.untracked ?? "");
    }
    throw new Error(`unexpected git argv: ${JSON.stringify(args)}`);
  });
}

beforeEach(() => {
  runGit.mockReset();
});

describe("normalizeFleetGitPath", () => {
  it("normalizes Windows separators without stripping hostile valid whitespace", () => {
    expect(normalizeFleetGitPath("src\\fleet\\worker.ts")).toBe(
      "src/fleet/worker.ts"
    );
    expect(normalizeFleetGitPath("src/odd\tname\nfile.ts")).toBe(
      "src/odd\tname\nfile.ts"
    );
    expect(normalizeFleetGitPath("./src//worker.ts")).toBe("src/worker.ts");
  });

  it("rejects absolute, traversal, NUL, and empty paths", () => {
    expect(normalizeFleetGitPath("C:\\outside\\secret.txt")).toBeNull();
    expect(normalizeFleetGitPath("\\\\server\\share\\file.txt")).toBeNull();
    expect(normalizeFleetGitPath("../outside.txt")).toBeNull();
    expect(normalizeFleetGitPath("src/../../outside.txt")).toBeNull();
    expect(normalizeFleetGitPath("src/evil\0name.ts")).toBeNull();
    expect(normalizeFleetGitPath(".")).toBeNull();
  });
});

describe("collectFleetGitState", () => {
  it("collects exact git truth for additions, deletions, renames, binary, dirty, and hostile paths", async () => {
    const oddPath = "src/odd\tname\nfile.ts";
    installGitFixture({
      committed: [
        "A",
        "src\\new.ts",
        "D",
        "src/old.ts",
        "R100",
        "src/before.ts",
        "src/after.ts",
        "M",
        "assets/logo.bin",
        "M",
        oddPath,
        "",
      ].join("\0"),
      numstat: [
        "2\t0\tsrc\\new.ts",
        "0\t3\tsrc/old.ts",
        "0\t0\t",
        "src/before.ts",
        "src/after.ts",
        "-\t-\tassets/logo.bin",
        `1\t1\t${oddPath}`,
        "",
      ].join("\0"),
      staged: ["R090", "lib\\old.ts", "lib\\new.ts", ""].join("\0"),
      unstaged: ["M", "src\\dirty.ts", ""].join("\0"),
      untracked: [".env.local", "notes/new\nthing.txt", ""].join("\0"),
    });

    const state = await collectFleetGitState({
      cwd: "C:\\work\\repo",
      baseSha: BASE_SHA.toUpperCase(),
      expectedHeadSha: HEAD_SHA,
      limits: { summaryPaths: 2 },
    });

    expect(state).toMatchObject({
      repositoryRoot: "C:/work/repo",
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      currentBranch: "feature/fleet-worker",
      summary: {
        committedFiles: 5,
        stagedFiles: 1,
        unstagedFiles: 1,
        untrackedFiles: 2,
        insertions: 3,
        deletions: 4,
        binaryFiles: 1,
        renamedFiles: 1,
        touchedPathsTruncated: true,
      },
    });
    expect(state.committedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "renamed",
          path: "src/after.ts",
          previousPath: "src/before.ts",
        }),
        expect.objectContaining({
          path: "assets/logo.bin",
          binary: true,
          insertions: null,
          deletions: null,
        }),
        expect.objectContaining({ path: oddPath }),
      ])
    );
    expect(state.committedPaths).toEqual(
      expect.arrayContaining(["src/new.ts", "src/before.ts", "src/after.ts"])
    );
    expect(state.dirtyTrackedPaths).toEqual([
      "lib/old.ts",
      "lib/new.ts",
      "src/dirty.ts",
    ]);
    expect(state.untrackedPaths).toEqual([
      ".env.local",
      "notes/new\nthing.txt",
    ]);
    expect(state.sensitivePaths).toContainEqual({
      path: ".env.local",
      reason: "environment_or_secret",
    });

    for (const call of runGit.mock.calls) {
      expect(Array.isArray(call[1])).toBe(true);
      expect(call[1]).not.toContain("sh");
      expect(call[1]).not.toContain("-c");
    }
    const committedCall = runGit.mock.calls.find(
      (call) =>
        (call[1] as string[]).includes("--name-status") &&
        (call[1] as string[]).includes(BASE_SHA)
    );
    expect(committedCall?.[1]).toEqual([
      "diff",
      "--name-status",
      "-z",
      "--find-renames=50%",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=none",
      BASE_SHA,
      HEAD_SHA,
      "--",
    ]);
  });

  it("represents a detached worktree branch as null", async () => {
    installGitFixture();
    const implementation = runGit.getMockImplementation();
    runGit.mockImplementation(async (...args: unknown[]) => {
      const argv = args[1] as string[];
      if (argv.join(" ") === "rev-parse --abbrev-ref HEAD") {
        return gitResult("HEAD\n");
      }
      return implementation?.(...args);
    });

    const state = await collectFleetGitState({
      cwd: "/repo",
      baseSha: BASE_SHA,
    });
    expect(state.currentBranch).toBeNull();
  });

  it("rejects abbreviated or ref-like input before invoking git", async () => {
    await expect(
      collectFleetGitState({ cwd: "/repo", baseSha: "main" })
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      collectFleetGitState({ cwd: "/repo", baseSha: BASE_SHA.slice(0, 12) })
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(runGit).not.toHaveBeenCalled();
  });

  it("fails closed when HEAD moved after authorization", async () => {
    installGitFixture();
    await expect(
      collectFleetGitState({
        cwd: "/repo",
        baseSha: BASE_SHA,
        expectedHeadSha: "c".repeat(40),
      })
    ).rejects.toMatchObject({ code: "head_mismatch" });
    expect(
      runGit.mock.calls.some((call) => (call[1] as string[])[0] === "diff")
    ).toBe(false);
  });

  it("fails closed when the base is not an ancestor", async () => {
    installGitFixture({ mergeBase: "c".repeat(40) });
    await expect(
      collectFleetGitState({ cwd: "/repo", baseSha: BASE_SHA })
    ).rejects.toMatchObject({
      code: "base_not_ancestor",
    });
  });

  it("fails closed on repository errors and hostile git-reported paths", async () => {
    runGit.mockRejectedValueOnce(new Error("not a repository"));
    await expect(
      collectFleetGitState({ cwd: "/missing", baseSha: BASE_SHA })
    ).rejects.toMatchObject({ code: "git_failed" });

    installGitFixture({
      committed: ["M", "../outside.ts", ""].join("\0"),
      numstat: ["1\t0\t../outside.ts", ""].join("\0"),
    });
    await expect(
      collectFleetGitState({ cwd: "/repo", baseSha: BASE_SHA })
    ).rejects.toMatchObject({
      code: "invalid_git_output",
    });
  });

  it("fails instead of truncating authoritative path sets", async () => {
    installGitFixture({
      untracked: ["one.ts", "two.ts", ""].join("\0"),
    });
    await expect(
      collectFleetGitState({
        cwd: "/repo",
        baseSha: BASE_SHA,
        limits: { maxPaths: 1 },
      })
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });
});

describe("compareFleetPathClaims", () => {
  it("uses path-segment prefix boundaries and normalizes Windows claims", () => {
    const result = compareFleetPathClaims(
      ["lib\\fleet", "docs/fleet-management.md"],
      [
        "lib/fleet/git-state.ts",
        "docs\\fleet-management.md",
        "lib/fleetish/not-covered.ts",
      ]
    );

    expect(result.normalizedClaims).toEqual([
      "lib/fleet",
      "docs/fleet-management.md",
    ]);
    expect(result.coveredPaths).toEqual([
      "lib/fleet/git-state.ts",
      "docs/fleet-management.md",
    ]);
    expect(result.driftPaths).toEqual(["lib/fleetish/not-covered.ts"]);
    expect(result.hasDrift).toBe(true);
  });

  it("treats __unknown__ and the legacy sentinel as wildcards", () => {
    for (const sentinel of [UNKNOWN_FLEET_PATH_CLAIM, "*"]) {
      const result = compareFleetPathClaims([sentinel], ["any/path.ts"]);
      expect(result).toMatchObject({
        unknownClaim: true,
        coveredPaths: ["any/path.ts"],
        driftPaths: [],
        hasDrift: false,
      });
    }
  });

  it("keeps malformed inputs blocking even alongside an unknown claim", () => {
    const result = compareFleetPathClaims(
      [UNKNOWN_FLEET_PATH_CLAIM, "../escape"],
      ["safe/file.ts", "C:\\outside\\file.ts"]
    );
    expect(result.invalidClaims).toEqual(["../escape"]);
    expect(result.invalidActualPaths).toEqual(["C:\\outside\\file.ts"]);
    expect(result.hasDrift).toBe(true);
  });

  it("reports sensitive paths independently of claim coverage", () => {
    const result = compareFleetPathClaims(
      [UNKNOWN_FLEET_PATH_CLAIM],
      [
        ".github/workflows/ci.yml",
        "src/auth/session.ts",
        "package-lock.json",
        "scripts/build-release.ts",
        "AGENTS.md",
        "db/migrations/001.sql",
        ".env.production",
      ]
    );

    expect(result.hasDrift).toBe(false);
    expect(result.sensitivePaths).toEqual([
      { path: ".github/workflows/ci.yml", reason: "automation" },
      { path: "src/auth/session.ts", reason: "authentication" },
      { path: "package-lock.json", reason: "dependency_lock" },
      { path: "scripts/build-release.ts", reason: "build_configuration" },
      { path: "AGENTS.md", reason: "repository_instructions" },
      { path: "db/migrations/001.sql", reason: "migration" },
      { path: ".env.production", reason: "environment_or_secret" },
    ]);
  });
});

describe("classifySensitiveFleetPath", () => {
  it("is case-insensitive for cross-platform safety", () => {
    expect(classifySensitiveFleetPath(".GITHUB\\WORKFLOWS\\release.yml")).toBe(
      "automation"
    );
    expect(classifySensitiveFleetPath("Nested\\AGENTS.MD")).toBe(
      "repository_instructions"
    );
  });
});
