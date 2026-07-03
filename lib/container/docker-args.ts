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
  /** Deterministic `--name` so a future reaper can GC an orphan. */
  name?: string;
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

/** A docker-safe `--name` derived from a session key (docker allows
 *  [a-zA-Z0-9][a-zA-Z0-9_.-]*). */
export function containerNameFor(key: string): string {
  const safe = key
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "");
  return `stoa-${safe || "session"}`.slice(0, 128);
}

export function buildDockerRunArgs(opts: DockerRunOptions): string[] {
  // -i -t are LOAD-BEARING: status detection reads the rendered VT screen (in-place
  // spinner ANSI), which only streams when the container allocates a real tty.
  const args = ["run", "--rm", "-i", "-t", "--init"];
  if (opts.name) args.push("--name", opts.name);
  args.push("--label", "stoa.session=1");
  for (const m of opts.mounts) {
    const ro = m.readonly ? ":ro" : "";
    // ONE token — docker parses the host:container[:ro] form (incl. a Windows
    // drive-letter colon on Docker Desktop). We never split it ourselves.
    args.push("-v", `${m.hostPath}:${m.containerPath}${ro}`);
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
