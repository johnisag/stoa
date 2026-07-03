/**
 * OS sandbox primitive detection (#27). The WHOLE cross-platform safety
 * mechanism: a missing sandbox binary NEVER fails a launch — detection returns
 * null and the wrapper degrades to a pass-through.
 *
 * Linux: bubblewrap (`bwrap`) — usually NOT installed by default (and some
 * distros disable unprivileged user namespaces), so it is feature-detected.
 * macOS `sandbox-exec` (Seatbelt) detection + profile composition is a follow-up
 * (PR1 returns null on darwin → pass-through, never fake isolation). Windows has
 * no equivalent → null.
 */

import { resolveBinary } from "../platform";
import type { SandboxTool } from "./types";

export interface DetectedSandbox {
  tool: SandboxTool;
  /** Absolute path to the primitive (never hardcoded — always resolved on PATH). */
  path: string;
}

/**
 * The OS sandbox primitive available on this host, or null. `platform` and the
 * binary `detect` are injectable so the whole matrix is unit-testable without a
 * real binary. Pure aside from the injected detector (defaults to resolveBinary).
 */
export function detectSandboxTool(
  platform: NodeJS.Platform = process.platform,
  detect: (name: string) => string | null = resolveBinary
): DetectedSandbox | null {
  if (platform === "linux") {
    const path = detect("bwrap");
    return path ? { tool: "bwrap", path } : null;
  }
  // darwin (Seatbelt) + win32: no wrapper shipped in PR1 → pass-through.
  return null;
}
