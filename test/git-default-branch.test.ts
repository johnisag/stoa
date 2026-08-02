import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getDefaultBranch,
  isGitRepo,
  resolveGitCommit,
} from "@/lib/git-status";
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

  it("resolves a branch to one exact commit and rejects option-shaped refs", () => {
    const directory = mkdtempSync(join(homeDir(), ".stoa-base-test-"));
    temporaryDirectories.push(directory);
    execFileSync("git", ["init", "-b", "main"], {
      cwd: directory,
      windowsHide: isWindows,
      stdio: "ignore",
    });
    writeFileSync(join(directory, "seed.txt"), "seed\n");
    execFileSync("git", ["add", "seed.txt"], {
      cwd: directory,
      windowsHide: isWindows,
      stdio: "ignore",
    });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Stoa Test",
        "-c",
        "user.email=stoa-test@localhost",
        "commit",
        "-m",
        "seed",
      ],
      { cwd: directory, windowsHide: isWindows, stdio: "ignore" }
    );
    const expected = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: directory,
      encoding: "utf-8",
      windowsHide: isWindows,
    }).trim();

    expect(resolveGitCommit(directory, "main")).toBe(expected);
    expect(resolveGitCommit(directory, "--all")).toBeNull();
  });
});
