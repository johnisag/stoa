import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression guard for the DESTRUCTIVE discard op behind /api/git/discard.
// discardChanges() permanently drops a file's uncommitted edits, so the exact
// git invocation matters twice over:
//   1. Safety/correctness — it MUST reach git as discrete argv via execFileSync
//      (no shell), so a path like "a; rm -rf / .txt" is a pathspec, never a
//      command. A revert to shell `execSync` would make these assertions fail.
//   2. Cross-platform — a bare "git" + argv spawns identically on Win/macOS/Linux
//      with windowsHide, vs a shell string that would quote differently per OS.
//
// We assert the command CONSTRUCTION for a TRACKED modified file (the common
// review case): detect-tracked via `ls-files --error-unmatch`, then restore via
// `git checkout -- <file>`. Mirrors the mock-exec approach in tmux-backend.test.ts
// and git-history-argv.test.ts.

const cp = vi.hoisted(() => ({
  execFileSync: vi.fn(
    (
      _file: string,
      _args: string[],
      _opts: { cwd?: string; windowsHide?: boolean }
    ) => ""
  ),
}));
vi.mock("child_process", () => ({ execFileSync: cp.execFileSync }));

// unlinkSync is only hit for the UNTRACKED branch; mock it so a stray call
// can't touch the real filesystem and so we can assert it is NOT used for a
// tracked file.
const fsMock = vi.hoisted(() => ({ unlinkSync: vi.fn() }));
vi.mock("fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs")>()),
  unlinkSync: fsMock.unlinkSync,
}));

import { discardChanges } from "@/lib/git-status";

describe("discardChanges builds the git restore argv (no shell)", () => {
  beforeEach(() => {
    cp.execFileSync.mockReset();
    cp.execFileSync.mockReturnValue("");
    fsMock.unlinkSync.mockReset();
  });

  it("tracked file: ls-files probe succeeds → `git checkout -- <file>` via execFileSync", () => {
    // `ls-files --error-unmatch` exits 0 for a tracked file (default mock).
    discardChanges("/repo", "src/app.ts");

    // Two git calls: the tracked-ness probe, then the restore. No shell, no unlink.
    expect(cp.execFileSync).toHaveBeenCalledTimes(2);
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();

    // 1) tracked-ness probe — a binary "git" + argv, never "/bin/sh"
    const [probeBin, probeArgs, probeOpts] = cp.execFileSync.mock.calls[0];
    expect(probeBin).toBe("git");
    expect(probeArgs).toEqual(["ls-files", "--error-unmatch", "src/app.ts"]);
    expect(probeOpts.cwd).toBe("/repo");

    // 2) the destructive restore — file is a single argv token after `--`
    const [bin, args, opts] = cp.execFileSync.mock.calls[1];
    expect(bin).toBe("git");
    expect(args).toEqual(["checkout", "--", "src/app.ts"]);
    expect(opts.cwd).toBe("/repo");
    // Windows: each short-lived git child must hide its console (no conhost flash).
    expect(opts.windowsHide).toBe(process.platform === "win32");
  });

  it("a path with shell metacharacters stays one argv token (not a command)", () => {
    const evil = "a; rm -rf / .txt";
    discardChanges("/repo", evil);

    const [, restoreArgs] = cp.execFileSync.mock.calls[1];
    // verbatim, as one element — git treats it as a (bad) pathspec, not a command
    expect(restoreArgs).toEqual(["checkout", "--", evil]);
  });

  it("untracked file: ls-files probe throws → unlinkSync, no checkout", () => {
    // First call (the probe) throws → file is untracked.
    cp.execFileSync.mockImplementationOnce(() => {
      throw new Error("error: pathspec did not match any file(s) known to git");
    });

    discardChanges("/repo", "new.txt");

    // Only the probe ran; we must NOT run a destructive `checkout` on an
    // untracked file (it would no-op/error) — we delete it instead.
    expect(cp.execFileSync).toHaveBeenCalledTimes(1);
    const [bin, args] = cp.execFileSync.mock.calls[0];
    expect(bin).toBe("git");
    expect(args).toEqual(["ls-files", "--error-unmatch", "new.txt"]);
    expect(fsMock.unlinkSync).toHaveBeenCalledTimes(1);
  });

  it("rejects a path that escapes the repo (no git call, no unlink)", () => {
    // The untracked branch deletes join(repo, file); a "../" file must NOT be
    // able to unlink outside the repo. The containment guard throws first.
    expect(() => discardChanges("/repo", "../../../etc/passwd")).toThrow(
      /outside the repository/
    );
    // An absolute path is likewise refused.
    expect(() => discardChanges("/repo", "/etc/passwd")).toThrow(
      /outside the repository/
    );
    // Nothing destructive ran — neither git nor unlink was reached.
    expect(cp.execFileSync).not.toHaveBeenCalled();
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });
});
