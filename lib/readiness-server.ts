/**
 * First-run onboarding readiness (#30) — the SERVER-side probes.
 *
 * `stoa doctor` performs richer versions of these checks, but it lives in
 * scripts/stoa.js (a CommonJS CLI, not importable here), so this is the
 * minimal server-side equivalent: which agent CLIs resolve on PATH, whether
 * the GitHub CLI is present, and best-effort evidence that an agent has been
 * signed in. Server-only (lib/platform + fs) — the pure step-decision core the
 * client imports lives in lib/readiness.ts.
 *
 * Every probe takes injectable deps so tests never touch the real PATH or
 * home directory (AGENTS.md: no real binaries in tests).
 */

import { existsSync } from "fs";
import path from "path";
import { homeDir, resolveBinary } from "@/lib/platform";
import {
  READINESS_AGENTS,
  type ReadinessAgent,
  type ReadinessPayload,
} from "@/lib/readiness";

/** Injectable probes (defaults are the real ones). */
export interface ReadinessProbes {
  resolve?: (name: string) => string | null;
  exists?: (p: string) => boolean;
  home?: () => string;
}

/** PATH presence for every agent CLI, via resolveBinary (`where`/`which`). */
export function detectAgentBinaries(
  resolve: (name: string) => string | null = resolveBinary
): Record<ReadinessAgent, boolean> {
  const out = {} as Record<ReadinessAgent, boolean>;
  for (const agent of READINESS_AGENTS) out[agent] = resolve(agent) !== null;
  return out;
}

/** The files an agent CLI's first-run/login flow writes, relative to home.
 *  Exported so the test can lock the list. Claude Code writes ~/.claude.json on
 *  first run everywhere (macOS keeps the token itself in the Keychain, but the
 *  marker file still appears); ~/.claude/.credentials.json is its on-disk
 *  credential store; Codex login writes ~/.codex/auth.json. Hermes/Kilo/Kimi
 *  have no verified marker yet — do not guess one. */
export const AUTH_EVIDENCE_FILES: readonly string[][] = [
  [".claude.json"],
  [".claude", ".credentials.json"],
  [".codex", "auth.json"],
];

/** Best-effort: does ANY known sign-in marker exist under the home dir? */
export function hasAgentAuthEvidence(
  exists: (p: string) => boolean = existsSync,
  home: () => string = homeDir
): boolean {
  const h = home();
  return AUTH_EVIDENCE_FILES.some((segments) => {
    try {
      return exists(path.join(h, ...segments));
    } catch {
      return false;
    }
  });
}

/** The full GET /api/readiness payload. */
export function collectReadiness(
  probes: ReadinessProbes = {}
): ReadinessPayload {
  const resolve = probes.resolve ?? resolveBinary;
  return {
    agents: detectAgentBinaries(resolve),
    gh: resolve("gh") !== null,
    authHint: hasAgentAuthEvidence(probes.exists, probes.home),
  };
}
