import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression test for the command-injection fix (review of PR #170). The
// `/api/git/history/[hash]` and `/api/git/history/[hash]/diff` routes feed a
// user-controlled commit hash (and a `file` query param) into these functions.
// They MUST reach git as discrete argv elements via execFileSync (no shell),
// never interpolated into a command string — otherwise `;cmd;` / `$(cmd)` would
// execute as the server user. These assertions fail if anyone reverts to shell
// `execSync` or mis-splits the argv.

const cp = vi.hoisted(() => ({
  execFileSync: vi.fn(
    (_file: string, _args: string[], _opts: { windowsHide?: boolean }) => ""
  ),
}));
vi.mock("child_process", () => ({ execFileSync: cp.execFileSync }));

import { getCommitFileDiff, getCommitDetail } from "@/lib/git-history";

describe("git-history passes attacker input as argv (no shell injection)", () => {
  beforeEach(() => {
    cp.execFileSync.mockReset();
    cp.execFileSync.mockReturnValue("");
  });

  it("getCommitFileDiff: malicious hash + path are single argv tokens", () => {
    const evilHash = "$(touch pwned); rm -rf /";
    const evilPath = "a; rm -rf / .txt";
    getCommitFileDiff("/repo", evilHash, evilPath);

    expect(cp.execFileSync).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = cp.execFileSync.mock.calls[0];
    expect(bin).toBe("git"); // a binary, not "/bin/sh" or a command string
    expect(args).toEqual([
      "show",
      "-m",
      "--first-parent",
      evilHash, // verbatim, as one element — git treats it as a (bad) rev, not a command
      "--",
      evilPath, // verbatim, as one element — a pathspec
    ]);
    expect(opts.windowsHide).toBe(true);
  });

  it("getCommitDetail: malicious hash is a single argv token", () => {
    const evilHash = "; calc & echo $(whoami)";
    getCommitDetail("/repo", evilHash);

    expect(cp.execFileSync).toHaveBeenCalled();
    const [bin, args] = cp.execFileSync.mock.calls[0];
    expect(bin).toBe("git");
    expect(args).toContain(evilHash); // discrete element, not concatenated
  });
});
