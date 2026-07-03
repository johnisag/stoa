/**
 * bubblewrap (bwrap) argv builder (#27) — PURE. Emits the sandbox flag prefix as
 * a discrete argv array; every dynamic value (an rwRoot path) is its OWN token,
 * so there is no shell and nothing can inject even a path containing spaces or
 * metacharacters.
 *
 * Confinement: the whole filesystem is READ-ONLY (`--ro-bind / /`) so tools and
 * libs stay usable, fresh /dev /proc /tmp are mounted, and only the policy's
 * rwRoots are rebound WRITABLE on top (later binds win in bwrap). `--unshare-net`
 * (opt-in) cuts egress. `--die-with-parent` ties the sandbox lifetime to the pty
 * so kill-on-exit still works.
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
  // Writable roots — each as three discrete tokens (no interpolation).
  for (const root of policy.rwRoots) {
    if (!root) continue;
    prefix.push("--bind", root, root);
  }
  if (!policy.allowNet) prefix.push("--unshare-net");
  // Terminate bwrap's own options; everything after is the command to run.
  prefix.push("--");
  return { file: bwrapPath, argsPrefix: prefix };
}
