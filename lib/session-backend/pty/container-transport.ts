/**
 * ContainerTransport (#47) — a DECORATOR PtyTransport (a third impl beside
 * LocalTransport/HostTransport, NOT a new backend). It composes a delegate
 * transport and rewrites ONLY the two spawn-bearing entry points (spawn +
 * attachStream) so the pty child becomes a `docker run` process; every other
 * method forwards verbatim to the delegate.
 *
 * That works because the delegated methods operate on the PtySession/registry,
 * and a PtySession fronting `docker run -it` streams the same rendered VT — so
 * capture()/serialize()/resize/write and status detection keep working UNCHANGED
 * (they read the rendered screen, not the child's nature). Lifetime is tied to
 * the pty via `docker run --rm` + a tty, so the existing kill path reaps the
 * container with no extra teardown.
 *
 * The docker argv is built by the pure, unit-tested lib/container builders; this
 * class only resolves the dynamic bits (git-common dir, config dirs) and delegates.
 */

import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { expandHome, homeDir } from "../../platform";
import { getAllProviderDefinitions } from "../../providers/registry";
import type { SessionActivity } from "../types";
import type { SpawnSpec } from "./registry";
import type { PtyTransport, AttachRequest, AttachHandle } from "./transport";
import {
  computeContainerMounts,
  CONTAINER_WORKDIR,
} from "../../container/mounts";
import {
  buildDockerRunArgs,
  containerNameFor,
  isValidImageName,
} from "../../container/docker-args";
import { detectContainerRuntime } from "../../container/detect";

const execFileAsync = promisify(execFile);

export class ContainerTransport implements PtyTransport {
  constructor(
    private readonly delegate: PtyTransport,
    private readonly dockerPath: string,
    private readonly image: string
  ) {}

  async spawn(key: string, spec: SpawnSpec): Promise<void> {
    const rewritten = await this.rewrite(key, spec);
    return this.delegate.spawn(key, rewritten);
  }

  async attachStream(req: AttachRequest): Promise<AttachHandle> {
    // Only rewrite a real create-with-a-binary; a plain shell (empty binary)
    // passes through unwrapped in PR1 (a bare in-container shell is a follow-up).
    if (req.spawn?.binary && req.spawn.binary.length > 0) {
      const r = await this.rewrite(req.key, {
        binary: req.spawn.binary,
        args: req.spawn.args ?? [],
        cwd: req.spawn.cwd ?? ".",
        cols: req.cols,
        rows: req.rows,
      });
      return this.delegate.attachStream({
        ...req,
        spawn: { binary: r.binary, args: r.args, cwd: r.cwd },
      });
    }
    return this.delegate.attachStream(req);
  }

  // ── the other 9 methods forward verbatim (container-agnostic) ──
  kill(key: string): Promise<void> {
    return this.delegate.kill(key);
  }
  rename(oldKey: string, newKey: string): Promise<void> {
    return this.delegate.rename(oldKey, newKey);
  }
  exists(key: string): Promise<boolean> {
    return this.delegate.exists(key);
  }
  list(): Promise<string[]> {
    return this.delegate.list();
  }
  listActivity(): Promise<SessionActivity[]> {
    return this.delegate.listActivity();
  }
  panePath(key: string): Promise<string | null> {
    return this.delegate.panePath(key);
  }
  pid(key: string): Promise<number | null> {
    return this.delegate.pid(key);
  }
  capture(key: string, lines?: number): Promise<string> {
    return this.delegate.capture(key, lines);
  }
  write(key: string, data: string): void {
    this.delegate.write(key, data);
  }

  /**
   * Rewrite a SpawnSpec so the pty runs `docker run … <image> <agent> <args>`.
   * The container edits the bind-mounted worktree in place, so its output lands
   * on the host (getSessionDiff runs host-side, unchanged).
   */
  private async rewrite(key: string, spec: SpawnSpec): Promise<SpawnSpec> {
    const worktree = expandHome(spec.cwd) || homeDir();
    const gitCommonDir = await resolveGitCommonDir(worktree);
    const mounts = computeContainerMounts({
      worktree,
      gitCommonDir,
      agentConfigDirs: knownAgentConfigDirs(),
      stoaHome: join(homeDir(), ".stoa"),
    });
    const args = buildDockerRunArgs({
      image: this.image,
      mounts,
      workdir: CONTAINER_WORKDIR,
      // Pass the caller's explicit env INTO the container. Env scrubbing is a
      // follow-up (as in the sandbox tier).
      env: spec.env ?? {},
      allowNet: true, // net-off is a follow-up (opt-in) — default keeps model/MCP reachable
      name: containerNameFor(key),
      agentBinary: spec.binary,
      agentArgs: spec.args,
    });
    // binary=docker (host); the container-side cwd is set via -w, so the docker
    // CLIENT just runs from the worktree (harmless). env is the docker client's
    // (host) overlay — the container env rode in via -e above.
    return {
      binary: this.dockerPath,
      args,
      cwd: worktree,
      cols: spec.cols,
      rows: spec.rows,
      env: spec.env,
    };
  }
}

/**
 * Wrap a delegate transport in the container transport when opt-in + docker +
 * a valid image are all present; otherwise return the delegate UNCHANGED
 * (fail-open — never break the plain pty launch). The env gate lives in
 * `useContainer()` (index.ts); this is the factory both selection sites call.
 */
export function wrapWithContainer(delegate: PtyTransport): PtyTransport {
  const detected = detectContainerRuntime();
  const image = process.env.STOA_CONTAINER_IMAGE;
  if (!detected || !isValidImageName(image)) return delegate;
  return new ContainerTransport(delegate, detected.path, image);
}

/** The known provider state dirs (expanded), so a containerized agent can auth +
 *  write its transcript regardless of which agent it is. */
function knownAgentConfigDirs(): string[] {
  const dirs = new Set<string>();
  for (const def of getAllProviderDefinitions()) {
    if (def.configDir) dirs.add(expandHome(def.configDir));
  }
  return [...dirs];
}

/** The main repo's git-common dir for a (possibly linked) worktree, or null. */
async function resolveGitCommonDir(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { windowsHide: true }
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
