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

import { spawn } from "child_process";
import { resolveBinary, isWindows } from "./platform";

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

/**
 * Run `claude -p` once, piping `prompt` on stdin, and resolve the RAW stdout on a
 * clean exit. Rejects on a non-zero exit (surfacing stderr) or a spawn error. The
 * caller post-processes the reply (e.g. cleanCommitMessage / sanitizeDigest).
 * Cross-platform via {@link buildClaudeOneshotPlan} — Windows `.cmd`-shim safe.
 *
 * No timeout (these are bounded, non-interactive `-p` prompts) — a future caller
 * that can wedge could grow one, like lib/ask.ts's runAsk kill-tree timeout.
 */
export function runClaudeOneshot(prompt: string): Promise<string> {
  const plan = buildClaudeOneshotPlan();
  return new Promise((resolve, reject) => {
    const child = spawn(plan.binary, plan.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: plan.shell,
      windowsHide: plan.windowsHide,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        console.error("Claude CLI failed:", stderr);
        reject(new Error(`Claude CLI exited with code ${code}`));
      }
    });
    child.on("error", reject);

    // The prompt is handed over on stdin (read by `claude -p`), never argv.
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
