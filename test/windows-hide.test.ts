import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression guard for the Windows "flashing conhost.exe" bug: in
// detached/production mode (no console to inherit) every short-lived child
// process Stoa spawns allocates a *visible* console window unless the spawn sets
// `windowsHide`. These assertions fail if a git/gh/ConPTY seam drops the flag.
//
// child_process is mocked so the test runs identically on all three OSes (no
// real git binary). We assert the option is threaded through, matching the
// current platform — `windowsHide: isWindows`.

type SpawnOpts = { windowsHide?: boolean };
type ExecCb = (e: unknown, r: { stdout: string; stderr: string }) => void;

const cp = vi.hoisted(() => ({
  execFileSync: vi.fn((_file: string, _args: string[], _opts: SpawnOpts) => ""),
  // promisify(execFile) calls it as (file, args, options, callback).
  execFile: vi.fn(
    (_file: string, _args: string[], _opts: SpawnOpts, cb: ExecCb) => {
      cb(null, { stdout: "", stderr: "" });
    }
  ),
}));

vi.mock("child_process", () => ({
  execFileSync: cp.execFileSync,
  execFile: cp.execFile,
}));

import { isGitRepo as isGitRepoSync } from "@/lib/git-status";
import { runGit } from "@/lib/git";
import { windowsConptyOptions } from "@/lib/session-backend/pty/registry";

const onWindows = process.platform === "win32";

describe("Windows console-flash hardening", () => {
  beforeEach(() => {
    cp.execFileSync.mockClear();
    cp.execFile.mockClear();
  });

  it("git-status seam (execFileSync) passes windowsHide for the platform", () => {
    isGitRepoSync("/tmp/repo");
    expect(cp.execFileSync).toHaveBeenCalled();
    const opts = cp.execFileSync.mock.calls[0][2] as { windowsHide?: boolean };
    expect(opts.windowsHide).toBe(onWindows);
  });

  it("runGit seam (execFile) passes windowsHide for the platform", async () => {
    await runGit("/tmp/repo", ["rev-parse", "--git-dir"], 5000);
    expect(cp.execFile).toHaveBeenCalled();
    const opts = cp.execFile.mock.calls[0][2] as { windowsHide?: boolean };
    expect(opts.windowsHide).toBe(onWindows);
  });

  it("windowsConptyOptions enables useConptyDll only on Windows", () => {
    expect(windowsConptyOptions("win32")).toEqual({ useConptyDll: true });
    expect(windowsConptyOptions("linux")).toEqual({});
    expect(windowsConptyOptions("darwin")).toEqual({});
  });
});
