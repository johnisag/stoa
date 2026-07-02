/**
 * One-shot `claude -p` runner — the shared, cross-platform-safe seam for the
 * non-interactive Claude calls behind a route (the AI commit-message draft and
 * the /summarize digest). Splits a PURE spawn-plan builder (the cross-platform
 * regression guard) from the impure runner, mirroring lib/ask.ts.
 *
 * Why it exists: both callers previously spawned `resolveBinary("claude")` with
 * `shell: false`. On Windows `claude` resolves to a `.cmd` shim, and spawning a
 * `.cmd` with `shell: false` throws `spawn EINVAL` — so both features were 100%
 * broken on Windows. The fix is the same shape lib/ask.ts already uses: spawn
 * with `shell: isWindows` (so cmd.exe runs the shim) and pipe the prompt on STDIN
 * (never argv — an argv prompt under a shell would be command-injectable).
 */

import { spawn, type ChildProcess } from "child_process";
import { resolveBinary, isWindows, killTreeArgs } from "./platform";

/** A resolved one-shot spawn plan. The prompt is NEVER here — it is always piped
 *  on stdin by {@link runClaudeOneshot} (see the module note). */
export interface ClaudeOneshotPlan {
  binary: string;
  args: string[];
  /** `true` on Windows so the `.cmd` shim is executable (else spawn EINVAL). */
  shell: boolean;
  windowsHide: boolean;
}

/**
 * Build the spawn plan for `claude -p` with the prompt piped on stdin. Pure
 * (resolveBinary aside) → unit-tested as the cross-platform guard: `args` is
 * always exactly `["-p"]` (the prompt is stdin, never argv), and `shell` tracks
 * `isWindows`. Falls back to the bare name when resolveBinary can't locate it.
 */
export function buildClaudeOneshotPlan(): ClaudeOneshotPlan {
  return {
    binary: resolveBinary("claude") || "claude",
    args: ["-p"],
    shell: isWindows,
    windowsHide: isWindows,
  };
}

/** Kill a spawned one-shot child — its whole tree on Windows, else child.kill().
 *  Mirrors lib/ask.ts's killChildTree (a `.cmd` shim under a shell leaves the
 *  real node process as a grandchild a bare kill() would orphan). */
function killChildTree(child: ChildProcess): void {
  const argv = child.pid ? killTreeArgs(child.pid, isWindows) : null;
  if (!argv) {
    child.kill();
    return;
  }
  try {
    const killer = spawn(argv[0], argv.slice(1), {
      stdio: "ignore",
      windowsHide: true,
    });
    // A killer launch failure surfaces as an ASYNC 'error' event — listen so it
    // can't crash the process, and degrade to the parent-only kill.
    killer.on("error", () => child.kill());
  } catch {
    child.kill();
  }
}

/** Ceiling on accumulated stdout — a runaway reply is killed, not buffered
 *  into an OOM (the callers keep only small heads/tails of the output anyway). */
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

/**
 * Run `claude -p` once, piping `prompt` on stdin, and resolve the RAW stdout on a
 * clean exit. Rejects on a non-zero exit (surfacing stderr), a spawn error, a
 * runaway reply (stdout cap), or — when `opts.timeoutMs` is set — a timeout,
 * KILLING the child tree in the latter two cases (an abandoned `claude -p` would
 * otherwise keep burning CPU + API quota). The caller post-processes the reply
 * (e.g. cleanCommitMessage / sanitizeDigest). Cross-platform via
 * {@link buildClaudeOneshotPlan} — Windows `.cmd`-shim safe.
 */
export function runClaudeOneshot(
  prompt: string,
  opts?: { timeoutMs?: number }
): Promise<string> {
  const plan = buildClaudeOneshotPlan();
  return new Promise((resolve, reject) => {
    const child = spawn(plan.binary, plan.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: plan.shell,
      windowsHide: plan.windowsHide,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (err: Error, kill: boolean) => {
      if (settled) return;
      settled = true;
      if (kill) killChildTree(child);
      if (timer) clearTimeout(timer);
      reject(err);
    };
    const timer = opts?.timeoutMs
      ? setTimeout(
          () =>
            fail(
              new Error(
                `Claude CLI timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s`
              ),
              true
            ),
          opts.timeoutMs
        )
      : null;
    timer?.unref?.();

    child.stdout.on("data", (data) => {
      stdout += data.toString();
      if (stdout.length > MAX_STDOUT_BYTES) {
        fail(new Error("Claude CLI output exceeded the size cap"), true);
      }
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        console.error("Claude CLI failed:", stderr);
        reject(new Error(`Claude CLI exited with code ${code}`));
      }
    });
    child.on("error", (err) => fail(err, false));

    // The prompt is handed over on stdin (read by `claude -p`), never argv.
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
