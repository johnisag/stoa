import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it } from "vitest";
import { isWindows, killTreeArgs } from "@/lib/platform";
import { runVerify } from "@/lib/verification/runner";

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "verification-descendant.cjs"
);
const cleanupPids = new Set<number>();
const cleanupDirs = new Set<string>();

function quoted(value: string): string {
  return `"${value}"`;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(processExists(pid)).toBe(false);
}

function forceCleanup(pid: number): void {
  if (!processExists(pid)) return;
  const argv = killTreeArgs(pid, isWindows);
  try {
    if (argv) {
      execFileSync(argv[0], argv.slice(1), {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // Best-effort test cleanup; the assertion reports the actual regression.
  }
}

afterEach(async () => {
  for (const pid of cleanupPids) {
    forceCleanup(pid);
    await waitForProcessExit(pid);
  }
  cleanupPids.clear();
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  cleanupDirs.clear();
});

type FixtureMode =
  "timeout" | "output" | "detached-timeout" | "detached-output";

async function runFixture(mode: FixtureMode): Promise<{
  dir: string;
  rootPid: number;
  descendantPid: number;
  elapsedMs: number;
  output: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "stoa-verify-tree-"));
  cleanupDirs.add(dir);
  const pidFile = join(dir, "descendant.pid");
  const started = Date.now();
  const result = await runVerify(
    dir,
    `node ${quoted(fixture)} ${mode} ${quoted(pidFile)}`,
    mode.endsWith("timeout")
      ? { timeoutMs: 500 }
      : { timeoutMs: 5_000, maxOutputBuffer: 32 * 1024 }
  );
  const rootPid = Number(readFileSync(`${pidFile}.root`, "utf-8"));
  const descendantPid = Number(readFileSync(pidFile, "utf-8"));
  cleanupPids.add(rootPid);
  cleanupPids.add(descendantPid);
  return {
    dir,
    rootPid,
    descendantPid,
    elapsedMs: Date.now() - started,
    output: result.output,
  };
}

async function expectTreeReapedAndDirectoryReleased(
  result: Awaited<ReturnType<typeof runFixture>>
): Promise<void> {
  await waitForProcessExit(result.rootPid);
  await waitForProcessExit(result.descendantPid);
  expect(() =>
    rmSync(result.dir, { recursive: true, force: true })
  ).not.toThrow();
  cleanupPids.delete(result.rootPid);
  cleanupPids.delete(result.descendantPid);
  cleanupDirs.delete(result.dir);
}

describe("verification runner process-tree teardown", () => {
  it("bounds a timeout and reaps the real descendant process", async () => {
    const result = await runFixture("timeout");
    expect(result.elapsedMs).toBeLessThan(4_000);
    expect(result.output).toMatch(/timed out/i);
    await expectTreeReapedAndDirectoryReleased(result);
  });

  it("bounds output overflow and reaps the real descendant process", async () => {
    const result = await runFixture("output");
    expect(result.elapsedMs).toBeLessThan(4_000);
    expect(result.output).toMatch(/output exceeded/i);
    await expectTreeReapedAndDirectoryReleased(result);
  });
});

const describePosix = isWindows ? describe.skip : describe;

describePosix("verification runner detached POSIX descendants", () => {
  it.each([
    ["timeout", "detached-timeout"],
    ["output overflow", "detached-output"],
  ] as const)("reaps a setsid descendant after %s", async (_label, mode) => {
    const result = await runFixture(mode);
    expect(result.elapsedMs).toBeLessThan(4_000);
    expect(result.output).toMatch(
      mode.endsWith("timeout") ? /timed out/i : /output exceeded/i
    );
    await expectTreeReapedAndDirectoryReleased(result);
  });
});
