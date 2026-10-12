import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { getRepoRoot } from "@/lib/git";
import { joinPath } from "@/lib/path-display";
import { homeDir, isWindows } from "@/lib/platform";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function initRepo(): string {
  const directory = mkdtempSync(join(homeDir(), ".stoa-repo-root-test-"));
  temporaryDirectories.push(directory);
  execFileSync("git", ["init", "-b", "main"], {
    cwd: directory,
    windowsHide: isWindows,
    stdio: "ignore",
  });
  return directory;
}

function gitIn(repo: string, args: string[]) {
  execFileSync("git", args, {
    cwd: repo,
    windowsHide: isWindows,
    stdio: "ignore",
  });
}

describe("getRepoRoot", () => {
  it("resolves the repo root from a SUBDIRECTORY cwd (the live-cwd git anchor)", async () => {
    const repo = initRepo();
    const sub = join(repo, "sub", "deep");
    mkdirSync(sub, { recursive: true });
    const nested = join(sub, "nested.txt");
    writeFileSync(nested, "x");
    // Track the file so porcelain reports its FULL path (wholly-untracked
    // directories are collapsed to "?? dir/" and carry no file path).
    gitIn(repo, ["add", "."]);
    gitIn(repo, [
      "-c",
      "user.email=t@stoa.local",
      "-c",
      "user.name=stoa-test",
      "commit",
      "-m",
      "init",
    ]);
    writeFileSync(nested, "modified");

    // The regression this locks: porcelain paths are REPO-root relative even
    // from a subdir cwd — so the anchor git surfaces must use is the ROOT.
    const root = await getRepoRoot(sub);
    expect(root).toBe(repo);

    const porcelainPath = execFileSync("git", ["status", "--porcelain"], {
      cwd: sub,
      windowsHide: isWindows,
    })
      .toString()
      .split("\n")
      .map((l) => l.slice(3).trim())
      .find((p) => p.replace(/\\/g, "/").endsWith("sub/deep/nested.txt"));
    expect(porcelainPath).toBeDefined();
    // Anchor at the resolved ROOT (not the subdir cwd): the join must point
    // at the file that actually exists.
    expect(joinPath(root!, porcelainPath!)).toBe(nested);
  });

  it("resolves the root itself unchanged", async () => {
    const repo = initRepo();
    expect(await getRepoRoot(repo)).toBe(repo);
  });

  it("returns null outside any work tree", async () => {
    const noRepo = mkdtempSync(join(homeDir(), ".stoa-repo-root-empty-"));
    temporaryDirectories.push(noRepo);
    expect(await getRepoRoot(noRepo)).toBeNull();
  });
});
