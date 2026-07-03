/**
 * Container mount policy (#47) — PURE. Maps the host directories an agent needs
 * to fixed POSIX paths inside the container. Reuses the same writable set the
 * sandbox tier enumerates (worktree + git-common-dir + agent state dir + ~/.stoa)
 * so a containerized worker can edit its worktree, run git, authenticate, and
 * reach Stoa's state.
 *
 * The HOST path is kept VERBATIM (the caller expands ~ first) — never split on
 * "/" or POSIX-assumed, since a Windows host path (C:\…) must pass through to
 * Docker Desktop unchanged. The CONTAINER path is always a fixed POSIX constant.
 */

export const CONTAINER_WORKDIR = "/workspace";
export const CONTAINER_HOME = "/root";

export interface ContainerMount {
  /** Host source (verbatim; may be a Windows path). */
  hostPath: string;
  /** Fixed POSIX path inside the container. */
  containerPath: string;
  /** Bind read-only (default read-write). */
  readonly?: boolean;
}

export interface ContainerMountInput {
  /** The session's worktree (its cwd) — mounted rw at CONTAINER_WORKDIR. */
  worktree: string;
  /** The main repo's git-common dir. Mounted at the SAME host path so a linked
   *  worktree's `.git` pointer resolves in-container — only when it is a POSIX
   *  absolute path (native Linux/macOS); omitted on a Windows host path (where an
   *  identical container path is impossible — in-container git for linked
   *  worktrees is a documented follow-up). */
  gitCommonDir?: string | null;
  /** The agents' state dirs (~/.claude, ~/.codex, …) — each mounted at
   *  CONTAINER_HOME/<base> so auth + the transcript work. The transport is
   *  agent-agnostic, so it passes every known provider config dir. */
  agentConfigDirs?: string[];
  /** Stoa's state dir (~/.stoa) — mounted at CONTAINER_HOME/.stoa. */
  stoaHome: string;
}

/** POSIX-absolute path? (a `/`-rooted host path we can mount at an identical
 *  container path). A Windows `C:\…` path is not. */
function isPosixAbsolute(p: string): boolean {
  return p.startsWith("/");
}

/** The trailing path segment (POSIX or Windows separators), for mapping a host
 *  state dir onto CONTAINER_HOME. */
export function baseName(p: string): string {
  const parts = p.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

export function computeContainerMounts(
  input: ContainerMountInput
): ContainerMount[] {
  const mounts: ContainerMount[] = [];
  const seen = new Set<string>();
  const add = (m: ContainerMount) => {
    if (!m.hostPath || seen.has(m.hostPath)) return;
    seen.add(m.hostPath);
    mounts.push(m);
  };

  add({ hostPath: input.worktree, containerPath: CONTAINER_WORKDIR });
  // git-common-dir at its identical POSIX path (native Linux/macOS) so a linked
  // worktree's `.git` file pointer resolves; skipped on a Windows host path.
  if (input.gitCommonDir && isPosixAbsolute(input.gitCommonDir)) {
    add({ hostPath: input.gitCommonDir, containerPath: input.gitCommonDir });
  }
  for (const dir of input.agentConfigDirs ?? []) {
    if (dir) {
      add({
        hostPath: dir,
        containerPath: `${CONTAINER_HOME}/${baseName(dir)}`,
      });
    }
  }
  add({
    hostPath: input.stoaHome,
    containerPath: `${CONTAINER_HOME}/${baseName(input.stoaHome)}`,
  });
  return mounts;
}
