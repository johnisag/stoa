import path from "path";

/**
 * Container mount policy (#47) — PURE. Maps the host directories an agent needs
 * to fixed POSIX paths inside the container. Reuses the same writable set the
 * sandbox tier enumerates (worktree + git-common-dir + agent state dir + exact
 * Fleet attempt output) so a containerized worker can edit its worktree, run
 * git, authenticate, and write only its assigned Fleet artifacts.
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
  /** The agents' state dirs (~/.claude, ~/.codex, ~/.config/kilo, …) — each
   *  mounted UNDER CONTAINER_HOME at its path relative to the host home, so a
   *  NESTED config dir lands where the in-container agent reads it (~/.config/kilo
   *  → /root/.config/kilo, not /root/kilo). The transport is agent-agnostic, so
   *  it passes every known provider config dir. */
  agentConfigDirs?: string[];
  /** Stoa's state dir (STOA_HOME or ~/.stoa). Used only to map validated Fleet
   *  attempt roots; the authority root itself is never mounted. */
  stoaHome: string;
  /** The host home dir, so a config/state dir maps to its home-RELATIVE path
   *  under CONTAINER_HOME (kept separator-tolerant for a Windows host). */
  homeDir: string;
  /** Exact, server-validated Fleet attempt directories that may be writable. */
  fleetWritableRoots?: string[];
}

/** POSIX-absolute path? (a `/`-rooted host path we can mount at an identical
 *  container path). A Windows `C:\…` path is not. */
function isPosixAbsolute(p: string): boolean {
  return p.startsWith("/");
}

/** The trailing path segment (POSIX or Windows separators). */
export function baseName(p: string): string {
  const parts = p.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

type HostPathApi = typeof path.posix | typeof path.win32;

function hostPathApi(value: string): HostPathApi {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)
    ? path.win32
    : path.posix;
}

function normalizedAbsolute(
  value: string,
  api: HostPathApi,
  label: string
): string {
  if (!value || !api.isAbsolute(value)) {
    throw new Error(`Unsafe STOA_HOME: ${label} must be an absolute host path`);
  }
  return api.resolve(value);
}

function isSameOrWithin(
  api: HostPathApi,
  parent: string,
  candidate: string
): boolean {
  const relative = api.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${api.sep}`) &&
      !api.isAbsolute(relative))
  );
}

/** Whether a workspace is one strict, Stoa-managed worktree descendant. */
export function isStrictContainerManagedWorktree(
  stoaHomeValue: string,
  worktreeValue: string
): boolean {
  const api = hostPathApi(stoaHomeValue);
  const stoaHome = normalizedAbsolute(stoaHomeValue, api, "STOA_HOME");
  const worktree = normalizedAbsolute(worktreeValue, api, "workspace");
  const managedWorktreesRoot = api.join(stoaHome, "worktrees");
  return (
    api.relative(managedWorktreesRoot, worktree) !== "" &&
    isSameOrWithin(api, managedWorktreesRoot, worktree)
  );
}

/**
 * Fail closed when a configured Stoa authority root is broad enough to expose
 * unrelated host data through a container bind. The function is deliberately
 * pure and selects path semantics from the supplied host paths, so Windows and
 * POSIX cases stay testable on every CI runner. Callers validate both lexical
 * resolved paths and real paths when they exist to catch symlinks/junctions.
 */
export function assertSafeContainerStoaHome(input: {
  stoaHome: string;
  homeDir: string;
  worktree: string;
  authorityPaths?: readonly string[];
}): void {
  const api = hostPathApi(input.stoaHome);
  const stoaHome = normalizedAbsolute(input.stoaHome, api, "STOA_HOME");
  const root = api.parse(stoaHome).root;
  if (isSameOrWithin(api, stoaHome, root)) {
    throw new Error("Unsafe STOA_HOME: filesystem roots cannot be exposed");
  }

  const homeDir = normalizedAbsolute(input.homeDir, api, "user home");
  if (isSameOrWithin(api, stoaHome, homeDir)) {
    throw new Error(
      "Unsafe STOA_HOME: it must not be the user home or one of its ancestors"
    );
  }

  const worktree = normalizedAbsolute(input.worktree, api, "workspace");
  const isExactManagedWorktree = isStrictContainerManagedWorktree(
    stoaHome,
    worktree
  );
  if (
    !isExactManagedWorktree &&
    (isSameOrWithin(api, stoaHome, worktree) ||
      isSameOrWithin(api, worktree, stoaHome))
  ) {
    throw new Error("Unsafe STOA_HOME: it must not overlap the workspace");
  }

  for (const value of input.authorityPaths ?? []) {
    if (!value) continue;
    const authority = normalizedAbsolute(value, api, "authority path");
    if (
      isSameOrWithin(api, stoaHome, authority) ||
      isSameOrWithin(api, authority, stoaHome)
    ) {
      throw new Error(
        "Unsafe STOA_HOME: it must not overlap another mounted authority path"
      );
    }
  }
}

/**
 * Map a host dir to its container path UNDER CONTAINER_HOME, preserving its path
 * RELATIVE to the host home so a nested dir (~/.config/kilo) lands at
 * /root/.config/kilo — not the basename-flattened /root/kilo (which the agent
 * wouldn't read). Falls back to the basename when the dir isn't under home.
 * Separator-tolerant (a Windows host home may use backslashes); the container
 * path is always POSIX.
 */
export function containerPathUnderHome(
  hostDir: string,
  homeDir: string
): string {
  const norm = (p: string) => p.replace(/[/\\]+/g, "/").replace(/\/+$/, "");
  const dir = norm(hostDir);
  const home = norm(homeDir);
  const rel =
    dir === home
      ? ""
      : dir.startsWith(home + "/")
        ? dir.slice(home.length + 1)
        : null;
  const suffix = rel ?? baseName(hostDir);
  return `${CONTAINER_HOME}/${suffix}`;
}

/**
 * Translate one host file path through an existing bind mount. The path flavor
 * is derived from the mount source rather than process.platform so Windows and
 * POSIX host paths remain testable on every CI OS.
 */
export function containerPathForMountedHostPath(
  hostPath: string,
  mount: Pick<ContainerMount, "hostPath" | "containerPath">
): string | null {
  const pathApi = path.win32.isAbsolute(mount.hostPath)
    ? path.win32
    : path.posix;
  const source = pathApi.resolve(mount.hostPath);
  const candidate = pathApi.resolve(hostPath);
  const relative = pathApi.relative(source, candidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relative)
  ) {
    return null;
  }
  if (!relative) return mount.containerPath;
  return path.posix.join(
    mount.containerPath,
    ...relative.split(/[\\/]+/).filter(Boolean)
  );
}

/** Replace only caller-authorized host paths in delivered container text. */
export function mapMountedHostPathsInText(
  text: string,
  hostPaths: readonly string[],
  mountOrMounts:
    | Pick<ContainerMount, "hostPath" | "containerPath">
    | readonly Pick<ContainerMount, "hostPath" | "containerPath">[]
): string {
  const mounts = Array.isArray(mountOrMounts)
    ? [...mountOrMounts]
    : [mountOrMounts];
  let mapped = text;
  for (const hostPath of hostPaths) {
    const containerPath = mounts
      .map((mount) => ({
        mount,
        translated: containerPathForMountedHostPath(hostPath, mount),
      }))
      .filter(
        (item): item is typeof item & { translated: string } =>
          item.translated !== null &&
          item.translated !== item.mount.containerPath
      )
      .sort(
        (a, b) => b.mount.hostPath.length - a.mount.hostPath.length
      )[0]?.translated;
    if (!containerPath) {
      throw new Error(
        "Fleet artifact path is outside the mounted Fleet attempt directories"
      );
    }
    mapped = mapped.split(hostPath).join(containerPath);
  }
  return mapped;
}

/**
 * Validate the only server-owned Fleet directory layouts that may cross the
 * final container mount boundary. This check deliberately lives beside mount
 * construction (and is shared by orchestration) so a forged or future SpawnSpec
 * cannot turn an arbitrary STOA_HOME child such as `secrets/` into a bind mount.
 *
 * Path semantics come from STOA_HOME, keeping Windows paths testable on every
 * CI host. Callers that can touch the filesystem must run this once for lexical
 * paths and once for their realpath-resolved targets.
 */
export function validateFleetWritableRootLayouts(
  roots: readonly string[],
  stoaHomeValue: string
): string[] {
  const seen = new Set<string>();
  const validated: string[] = [];
  for (const value of roots) {
    const { api, candidate } = fleetWritableRootIdentity(value, stoaHomeValue);
    const key = api === path.win32 ? candidate.toLowerCase() : candidate;
    if (!seen.has(key)) {
      seen.add(key);
      validated.push(candidate);
    }
  }
  return validated;
}

const FLEET_SAFE_PATH_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FLEET_RESERVED_PATH_COMPONENTS = new Set([
  "integrations",
  "planner",
  "supervisor",
]);
const POSITIVE_ATTEMPT_PATH_COMPONENT = /^[1-9][0-9]*$/;

function isFleetSafePathComponent(
  value: string,
  allowReserved = false
): boolean {
  return (
    FLEET_SAFE_PATH_COMPONENT.test(value) &&
    value !== "." &&
    value !== ".." &&
    (allowReserved || !FLEET_RESERVED_PATH_COMPONENTS.has(value.toLowerCase()))
  );
}

function isPositiveAttemptPathComponent(value: string): boolean {
  if (!POSITIVE_ATTEMPT_PATH_COMPONENT.test(value)) return false;
  return Number.isSafeInteger(Number(value));
}

/** Parse one exact server-generated writable-root identity below STOA_HOME. */
function fleetWritableRootIdentity(
  value: string,
  stoaHomeValue: string
): {
  api: HostPathApi;
  candidate: string;
  comparisonIdentity: string;
} {
  const api = hostPathApi(stoaHomeValue);
  const stoaHome = normalizedAbsolute(stoaHomeValue, api, "STOA_HOME");
  const candidate = normalizedAbsolute(value, api, "Fleet writable root");
  const relative = api.relative(stoaHome, candidate);
  const parts = relative.split(api.sep).filter(Boolean);
  const isWorkerAttempt =
    parts.length === 4 &&
    parts[0] === "fleet" &&
    isFleetSafePathComponent(parts[1]) &&
    isFleetSafePathComponent(parts[2]) &&
    isPositiveAttemptPathComponent(parts[3]);
  const isPlannerAttempt =
    parts.length === 4 &&
    parts[0] === "fleet" &&
    isFleetSafePathComponent(parts[1]) &&
    parts[2] === "planner" &&
    isFleetSafePathComponent(parts[3], true);
  const isAuxiliaryAttempt =
    parts.length === 5 &&
    parts[0] === "fleet-task-runtime" &&
    isFleetSafePathComponent(parts[1]) &&
    isFleetSafePathComponent(parts[2]) &&
    isPositiveAttemptPathComponent(parts[3]) &&
    (parts[4] === "reviews" || parts[4] === "fixes");
  if (
    !isSameOrWithin(api, stoaHome, candidate) ||
    (!isWorkerAttempt && !isPlannerAttempt && !isAuxiliaryAttempt)
  ) {
    throw new Error(
      "Fleet writable roots must identify one exact server-owned attempt directory"
    );
  }
  const identity = parts.join("/");
  return {
    api,
    candidate,
    comparisonIdentity: api === path.win32 ? identity.toLowerCase() : identity,
  };
}

/**
 * Ensure realpath resolution did not redirect a valid-looking writable root to
 * another run, task, planner request, or attempt. Both paths may independently
 * have valid layouts; their STOA_HOME-relative server-owned identity must still
 * be identical.
 */
export function assertFleetWritableRootIdentityPreserved(input: {
  lexicalRoots: readonly string[];
  lexicalStoaHome: string;
  realRoots: readonly string[];
  realStoaHome: string;
}): void {
  if (input.lexicalRoots.length !== input.realRoots.length) {
    throw new Error(
      "Fleet writable roots must resolve to the same server-owned attempt directory"
    );
  }
  for (let index = 0; index < input.lexicalRoots.length; index += 1) {
    const lexical = fleetWritableRootIdentity(
      input.lexicalRoots[index],
      input.lexicalStoaHome
    );
    const real = fleetWritableRootIdentity(
      input.realRoots[index],
      input.realStoaHome
    );
    if (lexical.comparisonIdentity !== real.comparisonIdentity) {
      throw new Error(
        "Fleet writable roots must resolve to the same server-owned attempt directory"
      );
    }
  }
}

/** Map exact Fleet attempt directories to their former STOA_HOME-relative
 * container locations without granting the container the authority root. */
export function fleetWritableRootMounts(
  roots: readonly string[],
  stoaHome: string,
  homeDir: string
): ContainerMount[] {
  const validatedRoots = validateFleetWritableRootLayouts(roots, stoaHome);
  const authorityMount = {
    hostPath: stoaHome,
    containerPath: containerPathUnderHome(stoaHome, homeDir),
  };
  return validatedRoots.map((hostPath) => {
    const containerPath = containerPathForMountedHostPath(
      hostPath,
      authorityMount
    );
    if (!containerPath || containerPath === authorityMount.containerPath) {
      throw new Error(
        "Fleet writable root must be an exact directory beneath STOA_HOME"
      );
    }
    return { hostPath, containerPath };
  });
}

export function computeContainerMounts(
  input: ContainerMountInput
): ContainerMount[] {
  assertSafeContainerStoaHome({
    stoaHome: input.stoaHome,
    homeDir: input.homeDir,
    worktree: input.worktree,
    authorityPaths: [
      ...(input.agentConfigDirs ?? []),
      ...(input.gitCommonDir ? [input.gitCommonDir] : []),
    ],
  });
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
        containerPath: containerPathUnderHome(dir, input.homeDir),
      });
    }
  }
  for (const mount of fleetWritableRootMounts(
    input.fleetWritableRoots ?? [],
    input.stoaHome,
    input.homeDir
  )) {
    add(mount);
  }
  return mounts;
}
