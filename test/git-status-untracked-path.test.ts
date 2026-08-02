import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { devNull, tmpdir } from "os";
import { join } from "path";

const childProcess = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFileSync: childProcess.execFileSync,
}));

import {
  getUntrackedFileDiff,
  resolveRepositoryRelativePath,
} from "@/lib/git-status";

describe("untracked file diff repository containment", () => {
  let sandbox: string;
  let repository: string;
  let outsideFile: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "stoa-untracked-diff-"));
    repository = join(sandbox, "repo");
    mkdirSync(repository);
    outsideFile = join(sandbox, "secret.txt");
    writeFileSync(outsideFile, "outside secret");

    childProcess.execFileSync.mockReset();
    childProcess.execFileSync.mockImplementation(() => {
      throw Object.assign(new Error("git diff found changes"), {
        stdout: "safe diff",
      });
    });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("passes an existing in-repository file to git as a relative argv token", () => {
    const nested = join(repository, "nested");
    const file = join(nested, "safe.txt");
    mkdirSync(nested);
    writeFileSync(file, "safe");

    expect(resolveRepositoryRelativePath(repository, "nested/safe.txt")).toBe(
      join("nested", "safe.txt")
    );
    expect(getUntrackedFileDiff(repository, "nested/safe.txt")).toBe(
      "safe diff"
    );
    expect(childProcess.execFileSync).toHaveBeenCalledWith(
      "git",
      ["diff", "--no-index", "--", devNull, join("nested", "safe.txt")],
      expect.objectContaining({ cwd: repository, windowsHide: true })
    );
  });

  it.each(["../secret.txt", "..\\secret.txt"])(
    "rejects parent traversal %s before invoking git",
    (filePath) => {
      expect(() => resolveRepositoryRelativePath(repository, filePath)).toThrow(
        /outside the repository/i
      );
      expect(getUntrackedFileDiff(repository, filePath)).toBe("");
      expect(childProcess.execFileSync).not.toHaveBeenCalled();
    }
  );

  it("rejects native and foreign-platform absolute paths before invoking git", () => {
    for (const filePath of [
      outsideFile,
      "C:\\outside\\secret.txt",
      "/outside/secret.txt",
    ]) {
      expect(() => resolveRepositoryRelativePath(repository, filePath)).toThrow(
        /relative path/i
      );
      expect(getUntrackedFileDiff(repository, filePath)).toBe("");
    }
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  it("rejects a symlink or junction that escapes the repository", () => {
    const outsideDirectory = join(sandbox, "outside");
    const outsideSecret = join(outsideDirectory, "linked-secret.txt");
    const escape = join(repository, "escape");
    mkdirSync(outsideDirectory);
    writeFileSync(outsideSecret, "linked outside secret");
    symlinkSync(
      outsideDirectory,
      escape,
      process.platform === "win32" ? "junction" : "dir"
    );

    expect(() =>
      resolveRepositoryRelativePath(repository, "escape/linked-secret.txt")
    ).toThrow(/outside the repository/i);
    expect(getUntrackedFileDiff(repository, "escape/linked-secret.txt")).toBe(
      ""
    );
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });
});
