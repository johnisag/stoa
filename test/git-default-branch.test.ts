import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { basename, join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { getDefaultBranch, isGitRepo } from "@/lib/git-status";
import { homeDir, isWindows } from "@/lib/platform";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("getDefaultBranch", () => {
  it("expands a tilde-backed checkout and falls back to its current branch", () => {
    const directory = mkdtempSync(join(homeDir(), ".stoa-branch-test-"));
    temporaryDirectories.push(directory);
    execFileSync("git", ["init", "-b", "develop"], {
      cwd: directory,
      windowsHide: isWindows,
      stdio: "ignore",
    });

    const tildePath = join("~", basename(directory));
    expect(isGitRepo(tildePath)).toBe(true);
    expect(getDefaultBranch(tildePath)).toBe("develop");
  });
});
