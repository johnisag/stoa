/**
 * Regression: on Windows, PtySession.killAndWait must reap the WHOLE process tree
 * (`taskkill /T /F`), not just the conpty wrapper. Agent CLIs are `.cmd` shims, so
 * node-pty's kill (and the old `process.kill(pid)` follow-up) stops only cmd.exe and
 * orphans the shim → node → agent descendants. This mirrors the fix already in
 * ClaudeProcessManager.cancelSession; the pty path had been missed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.fn(
  (
    _bin: string,
    _args: string[],
    _opts: unknown,
    cb?: (e: Error | null) => void
  ) => cb?.(null)
);
vi.mock("child_process", () => ({
  execFile: (
    bin: string,
    args: string[],
    opts: unknown,
    cb?: (e: Error | null) => void
  ) => execFileMock(bin, args, opts, cb),
}));

// Force the Windows branch while keeping killTreeArgs real.
vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>();
  return { ...actual, isWindows: true };
});

import { PtySession } from "@/lib/session-backend/pty/pty-session";

type ExitCb = (e: { exitCode: number }) => void;
function fakePty(pid: number) {
  const exits: ExitCb[] = [];
  return {
    pid,
    onData: () => ({ dispose() {} }),
    onExit: (cb: ExitCb) => {
      exits.push(cb);
      return { dispose() {} };
    },
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    fireExit: (code = 0) => exits.forEach((cb) => cb({ exitCode: code })),
  };
}

function makeSession(pid: number) {
  const pty = fakePty(pid);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const session = new PtySession({
    key: "codex-1",
    cwd: ".",
    pty: pty as any,
    cols: 80,
    rows: 24,
  });
  return { session, pty };
}

beforeEach(() => execFileMock.mockClear());

describe("PtySession.killAndWait — Windows tree teardown", () => {
  it("force-kills the tree via `taskkill /PID <pid> /T /F` when the wrapper survives", async () => {
    // Use the test runner's own pid so the private processExists() check
    // (process.kill(pid, 0)) reports it as alive and the tree-kill branch runs.
    const { session, pty } = makeSession(process.pid);
    const p = session.killAndWait(50);
    pty.fireExit(0); // resolve the wait so we don't sit on the timeout
    await p;

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = execFileMock.mock.calls[0];
    expect(bin).toBe("taskkill");
    expect(args).toEqual(["/PID", String(process.pid), "/T", "/F"]);
    expect(opts).toEqual({ windowsHide: true });
  });

  it("does NOT shell out when the process is already gone after a graceful kill", async () => {
    // A pid that doesn't exist → processExists() is false → no taskkill.
    const { session, pty } = makeSession(2_000_000_000);
    const p = session.killAndWait(50);
    pty.fireExit(0);
    await p;
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
