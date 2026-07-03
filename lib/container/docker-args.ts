/**
 * `docker run` argv builder (#47) — PURE. Emits the argv as a discrete array:
 * every mount, env pair, and path is its OWN token, so there is no shell and an
 * untrusted worktree path or image name can't inject a flag or a command
 * (mirrors lib/sandbox/linux.ts). node-pty spawns docker directly with this argv.
 *
 * Model (Lens A): ONE ephemeral `docker run --rm` per session with a real tty, so
 * the container's lifetime is tied to the pty client — killing the pty stops AND
 * removes the container (no separate teardown), `--init` reaps in-container
 * zombies, and the bind-mounted worktree means the agent's edits land on the host.
 */

import type { ContainerMount } from "./mounts";

export interface DockerRunOptions {
  image: string;
  mounts: ContainerMount[];
  /** Container-side workdir (a fixed POSIX path). */
  workdir: string;
  /** Env passed INTO the container as discrete `-e K=V` tokens. */
  env: Record<string, string>;
  /** false → `--network none` (cut egress). */
  allowNet: boolean;
  /** Session key — stamped as a `--label` so a future reaper can GC orphans by
   *  filter, WITHOUT a deterministic `--name` (which would collide on a
   *  same-session respawn after an abnormal crash left the container). */
  sessionKey?: string;
  /** The agent binary + args to run inside the image. */
  agentBinary: string;
  agentArgs: string[];
}

// A conservative registry/name[:tag][@digest] charset. The image rides as ONE
// argv token (no shell), so this is defense-in-depth — a malformed value fails
// fast rather than mislaunching (echoes the model-token-injection lesson).
const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,199}$/;

export function isValidImageName(image: unknown): image is string {
  return typeof image === "string" && IMAGE_RE.test(image);
}

export function buildDockerRunArgs(opts: DockerRunOptions): string[] {
  // -i -t are LOAD-BEARING: status detection reads the rendered VT screen (in-place
  // spinner ANSI), which only streams when the container allocates a real tty.
  const args = ["run", "--rm", "-i", "-t", "--init"];
  args.push("--label", `stoa.session=${opts.sessionKey ?? "1"}`);
  for (const m of opts.mounts) {
    // `--mount` (comma-keyed) NOT `-v` (colon-split): a host path may legally
    // contain a ':' (POSIX) or a Windows drive colon, which `-v host:ctr` would
    // misparse into a spurious mount option (e.g. :ro / :z). With `--mount` the
    // src/dst are explicit keys, so an embedded colon can't shift a field.
    const parts = [`type=bind`, `src=${m.hostPath}`, `dst=${m.containerPath}`];
    if (m.readonly) parts.push("readonly");
    args.push("--mount", parts.join(","));
  }
  args.push("-w", opts.workdir);
  for (const [k, v] of Object.entries(opts.env)) {
    args.push("-e", `${k}=${v}`);
  }
  if (!opts.allowNet) args.push("--network", "none");
  // image, then the agent command — everything after the image runs in-container.
  args.push(opts.image, opts.agentBinary, ...opts.agentArgs);
  return args;
}
