import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock execFileSync so we can assert the exact argv (no shell string) each
// helper builds, and control its stdout/throw per test. resolveBinary is stubbed
// to "gh" so the test is OS-independent (no real `where`/`which gh`).
const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("child_process", () => ({ execFileSync: execFileSyncMock }));
vi.mock("@/lib/platform", () => ({ resolveBinary: () => "gh" }));

import {
  checkGhCli,
  getCommitsSinceBase,
  getPRForBranch,
  getCurrentBranch,
  createPR,
  getBaseBranch,
} from "@/lib/pr";

const CWD = "/work/dir";

beforeEach(() => {
  execFileSyncMock.mockReset();
});

describe("pr.ts — execFile argv (no shell strings)", () => {
  it("checkGhCli runs `gh auth status` as argv; success/throw -> bool", () => {
    execFileSyncMock.mockReturnValue("");
    expect(checkGhCli()).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "gh",
      ["auth", "status"],
      expect.objectContaining({ timeout: 5000, stdio: "pipe" })
    );

    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not authenticated");
    });
    expect(checkGhCli()).toBe(false);
  });

  it("getCommitsSinceBase: merge-base + log argv, --format is one UNQUOTED token", () => {
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args[0] === "merge-base") return "BASE_SHA\n";
      if (args[0] === "log")
        return "COMMIT_START\nabc123\nfeat: x\nbody line\nCOMMIT_END\n";
      return "";
    });

    const commits = getCommitsSinceBase(CWD, "main");

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["merge-base", "main", "HEAD"],
      expect.objectContaining({ cwd: CWD })
    );
    const logCall = execFileSyncMock.mock.calls.find(
      (c) => (c[1] as string[])[0] === "log"
    )!;
    expect(logCall[1]).toEqual([
      "log",
      "BASE_SHA..HEAD",
      "--format=COMMIT_START%n%H%n%s%n%b%nCOMMIT_END",
    ]);
    // Regression guard: the format token must NOT carry the old shell quotes.
    expect((logCall[1] as string[])[2]).not.toContain('"');
    expect(commits).toEqual([
      { hash: "abc123", subject: "feat: x", body: "body line" },
    ]);
  });

  it("getPRForBranch: branch name is ONE argv token (spaces safe), JSON parsed", () => {
    execFileSyncMock.mockReturnValue(
      JSON.stringify([{ number: 7, url: "u", state: "open", title: "t" }])
    );
    const pr = getPRForBranch(CWD, "feat/my branch");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "gh",
      [
        "pr",
        "list",
        "--head",
        "feat/my branch",
        "--json",
        "number,url,state,title",
        "--limit",
        "1",
      ],
      expect.objectContaining({ cwd: CWD, timeout: 10000 })
    );
    expect(pr).toEqual({ number: 7, url: "u", state: "open", title: "t" });
  });

  it("getCurrentBranch: argv + trim", () => {
    execFileSyncMock.mockReturnValue("feat/x\n");
    expect(getCurrentBranch(CWD)).toBe("feat/x");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["branch", "--show-current"],
      expect.objectContaining({ cwd: CWD })
    );
  });

  it("createPR: push then gh create with body as one VERBATIM argv token", () => {
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      if (args[0] === "push") return "";
      if (args[0] === "pr" && args[1] === "create")
        return "View pull request: https://github.com/o/r/pull/42\n";
      return "";
    });
    const body = '## Summary\n\n- line with "quotes" and $vars\n';
    const pr = createPR(CWD, "feat/x", "main", "my title", body);

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["push", "-u", "origin", "feat/x"],
      expect.objectContaining({ cwd: CWD, timeout: 30000, stdio: "pipe" })
    );
    const createCall = execFileSyncMock.mock.calls.find(
      (c) =>
        (c[1] as string[])[0] === "pr" && (c[1] as string[])[1] === "create"
    )!;
    expect(createCall[0]).toBe("gh");
    expect(createCall[1]).toEqual([
      "pr",
      "create",
      "--title",
      "my title",
      "--base",
      "main",
      "--body",
      body, // multi-line, quotes, $ — survives as a single unescaped token
    ]);
    expect(pr).toEqual({
      number: 42,
      url: "https://github.com/o/r/pull/42",
      state: "open",
      title: "my title",
    });
  });

  it("getBaseBranch: reads origin HEAD via argv; falls back to main on throw", () => {
    execFileSyncMock.mockReturnValue("refs/remotes/origin/develop\n");
    expect(getBaseBranch(CWD)).toBe("develop");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      expect.objectContaining({ cwd: CWD })
    );

    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementation(() => {
      throw new Error("no symbolic ref");
    });
    expect(getBaseBranch(CWD)).toBe("main");
  });
});
