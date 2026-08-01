/**
 * bubblewrap (bwrap) argv builder (#27) — PURE. Emits the sandbox flag prefix as
 * a discrete argv array; every dynamic value (an rwRoot path) is its OWN token,
 * so there is no shell and nothing can inject even a path containing spaces or
 * metacharacters.
 *
 * Confinement: the whole filesystem is READ-ONLY (`--ro-bind / /`) so tools and
 * libs stay usable, fresh /dev /proc /tmp are mounted, authority roots are
 * hidden, and only the policy's exact rwRoots are rebound WRITABLE on top.
 * Bubblewrap resolves bind sources through its old-root namespace, so exact
 * attempt directories can be rebound after their Stoa parent is hidden.
 * `--unshare-net` (opt-in) cuts egress. `--die-with-parent` ties the sandbox
 * lifetime to the pty so kill-on-exit still works.
 */

import type { SandboxPolicy } from "./types";

export function buildBwrapArgs(
  bwrapPath: string,
  policy: SandboxPolicy
): { file: string; argsPrefix: string[] } {
  const prefix: string[] = [
    "--die-with-parent",
    // Whole FS read-only, then re-mount volatile dirs and re-bind writable roots.
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
  ];
  // Hide server-owned state before exposing the exact attempt directories below.
  for (const root of policy.hiddenRoots ?? []) {
    if (!root) continue;
    prefix.push("--tmpfs", root);
  }
  // Writable roots — each as three discrete tokens (no interpolation).
  for (const root of policy.rwRoots) {
    if (!root) continue;
    prefix.push("--bind", root, root);
  }
  // A DB_PATH may intentionally live outside STOA_HOME. Mask exact authority
  // files after writable binds so even a path nested in a worktree stays hidden.
  for (const file of policy.maskedPaths ?? []) {
    if (!file) continue;
    prefix.push("--ro-bind", "/dev/null", file);
  }
  for (const name of policy.unsetEnv ?? []) {
    if (!name) continue;
    prefix.push("--unsetenv", name);
  }
  if (!policy.allowNet) prefix.push("--unshare-net");
  // Terminate bwrap's own options; everything after is the command to run.
  prefix.push("--");
  return { file: bwrapPath, argsPrefix: prefix };
}
