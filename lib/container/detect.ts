/**
 * Container runtime detection (#47). The cross-platform safety mechanism: a
 * missing `docker` NEVER fails a launch — detection returns null and the
 * transport selection degrades to a plain host pty (see index.ts).
 *
 * Mirrors lib/sandbox/detect.ts exactly: feature-detect via `resolveBinary`
 * (never hardcode a path), injectable for unit tests, no real daemon touched.
 */

import { resolveBinary } from "../platform";

export type ContainerRuntime = "docker";

export interface DetectedContainerRuntime {
  runtime: ContainerRuntime;
  /** Absolute path to the CLI (resolved on PATH — `docker.exe` on Windows). */
  path: string;
}

/**
 * The container runtime available on this host, or null. `detect` (the binary
 * resolver) is injectable so the whole matrix is unit-testable without a real
 * docker. Only `docker` in PR1; podman is a follow-up.
 */
export function detectContainerRuntime(
  detect: (name: string) => string | null = resolveBinary
): DetectedContainerRuntime | null {
  const path = detect("docker");
  return path ? { runtime: "docker", path } : null;
}
