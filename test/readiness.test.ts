/**
 * First-run onboarding readiness (#30).
 *
 * Locks the PURE decision core (lib/readiness.ts): the payload → step-completion
 * matrix, the loopback-vs-remote hostname check, and the dismissed-flag logic —
 * plus the server probes (lib/readiness-server.ts) with INJECTED resolver/fs
 * deps, so no real binaries or home directory are ever touched (CI matrix safe).
 */

import { describe, it, expect } from "vitest";
import path from "path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import {
  READINESS_AGENTS,
  EMPTY_READINESS,
  foundAgents,
  computeOnboardingSteps,
  onboardingProgress,
  isRemoteHostname,
  shouldShowOnboarding,
  ONBOARDING_DISMISSED_KEY,
  type OnboardingInputs,
  type ReadinessPayload,
} from "@/lib/readiness";
import {
  detectAgentBinaries,
  hasAgentAuthEvidence,
  collectReadiness,
  fileExists,
  AUTH_EVIDENCE_FILES,
} from "@/lib/readiness-server";

/** A payload with the given agents present (everything else false). */
function payloadWith(
  agents: string[] = [],
  extra: Partial<ReadinessPayload> = {}
): ReadinessPayload {
  return {
    ...EMPTY_READINESS,
    agents: Object.fromEntries(
      READINESS_AGENTS.map((a) => [a, agents.includes(a)])
    ) as ReadinessPayload["agents"],
    ...extra,
  };
}

/** All-false inputs; override per case. */
function inputs(over: Partial<OnboardingInputs> = {}): OnboardingInputs {
  return {
    readiness: EMPTY_READINESS,
    hasProjects: false,
    hasSessions: false,
    isRemoteClient: false,
    ...over,
  };
}

function stepById(
  steps: ReturnType<typeof computeOnboardingSteps>,
  id: string
) {
  const step = steps.find((s) => s.id === id);
  if (!step) throw new Error(`missing step ${id}`);
  return step;
}

describe("computeOnboardingSteps — the payload → steps matrix", () => {
  it("renders all five steps in order, all todo on a cold machine", () => {
    const steps = computeOnboardingSteps(inputs());
    expect(steps.map((s) => s.id)).toEqual([
      "agent-cli",
      "agent-auth",
      "working-dir",
      "remote-access",
      "first-session",
    ]);
    expect(steps.every((s) => !s.done)).toBe(true);
  });

  it("marks agent-cli done when any agent CLI is found, listing the found ones", () => {
    const steps = computeOnboardingSteps(
      inputs({ readiness: payloadWith(["claude", "codex"], { gh: true }) })
    );
    const step = stepById(steps, "agent-cli");
    expect(step.done).toBe(true);
    expect(step.detail).toContain("claude, codex");
  });

  it("appends the gh tip only when gh is missing", () => {
    const withGh = stepById(
      computeOnboardingSteps(
        inputs({ readiness: payloadWith(["claude"], { gh: true }) })
      ),
      "agent-cli"
    );
    const withoutGh = stepById(
      computeOnboardingSteps(
        inputs({ readiness: payloadWith(["claude"], { gh: false }) })
      ),
      "agent-cli"
    );
    expect(withGh.detail).not.toContain("gh");
    expect(withoutGh.detail).toContain("GitHub CLI (gh)");
  });

  it("agent-auth requires BOTH a found agent AND auth evidence", () => {
    // Evidence but no CLI on PATH (stale ~/.claude.json) must NOT read signed-in.
    const evidenceOnly = computeOnboardingSteps(
      inputs({ readiness: payloadWith([], { authHint: true }) })
    );
    expect(stepById(evidenceOnly, "agent-auth").done).toBe(false);

    const cliOnly = computeOnboardingSteps(
      inputs({ readiness: payloadWith(["claude"]) })
    );
    expect(stepById(cliOnly, "agent-auth").done).toBe(false);

    const both = computeOnboardingSteps(
      inputs({ readiness: payloadWith(["claude"], { authHint: true }) })
    );
    expect(stepById(both, "agent-auth").done).toBe(true);
  });

  it("working-dir tracks project existence", () => {
    expect(stepById(computeOnboardingSteps(inputs()), "working-dir").done).toBe(
      false
    );
    expect(
      stepById(
        computeOnboardingSteps(inputs({ hasProjects: true })),
        "working-dir"
      ).done
    ).toBe(true);
  });

  it("remote-access is optional and tracks the remote-client flag", () => {
    const local = stepById(computeOnboardingSteps(inputs()), "remote-access");
    expect(local.optional).toBe(true);
    expect(local.done).toBe(false);
    const remote = stepById(
      computeOnboardingSteps(inputs({ isRemoteClient: true })),
      "remote-access"
    );
    expect(remote.done).toBe(true);
  });

  it("first-session tracks session existence", () => {
    expect(
      stepById(computeOnboardingSteps(inputs()), "first-session").done
    ).toBe(false);
    expect(
      stepById(
        computeOnboardingSteps(inputs({ hasSessions: true })),
        "first-session"
      ).done
    ).toBe(true);
  });
});

describe("onboardingProgress", () => {
  it("counts only the REQUIRED steps (remote-access is advisory)", () => {
    // Everything done including the optional step → still x/4, not x/5.
    const all = computeOnboardingSteps(
      inputs({
        readiness: payloadWith(["claude"], { authHint: true, gh: true }),
        hasProjects: true,
        hasSessions: true,
        isRemoteClient: true,
      })
    );
    expect(onboardingProgress(all)).toEqual({ done: 4, total: 4 });
    expect(onboardingProgress(computeOnboardingSteps(inputs()))).toEqual({
      done: 0,
      total: 4,
    });
  });
});

describe("foundAgents", () => {
  it("maps the presence record to an ordered list", () => {
    expect(foundAgents(payloadWith(["kimi", "claude"]).agents)).toEqual([
      "claude",
      "kimi",
    ]);
    expect(foundAgents(EMPTY_READINESS.agents)).toEqual([]);
  });
});

describe("isRemoteHostname", () => {
  it("treats loopback (and empty) as local", () => {
    for (const h of [
      "localhost",
      "LOCALHOST",
      "127.0.0.1",
      "::1",
      "[::1]",
      "",
      "  ",
    ]) {
      expect(isRemoteHostname(h)).toBe(false);
    }
  });

  it("treats anything else as remote", () => {
    for (const h of ["192.168.1.7", "stoa.local", "my-desktop", "10.0.0.2"]) {
      expect(isRemoteHostname(h)).toBe(true);
    }
  });
});

describe("shouldShowOnboarding — dismissed-flag logic", () => {
  it("shows only on the empty state and only until dismissed", () => {
    expect(shouldShowOnboarding(0, null)).toBe(true);
    expect(shouldShowOnboarding(0, "1")).toBe(false);
    expect(shouldShowOnboarding(3, null)).toBe(false);
    expect(shouldShowOnboarding(3, "1")).toBe(false);
    // Any non-"1" stored value still shows (only the canonical flag dismisses).
    expect(shouldShowOnboarding(0, "")).toBe(true);
  });

  it("locks the localStorage key", () => {
    expect(ONBOARDING_DISMISSED_KEY).toBe("stoa-onboarding-dismissed");
  });
});

describe("detectAgentBinaries — binary-presence mapping (injected resolver)", () => {
  it("maps each agent to whether the resolver finds it", () => {
    const present = new Set(["claude", "kilo"]);
    const resolve = (name: string) =>
      present.has(name) ? `/usr/local/bin/${name}` : null;
    expect(detectAgentBinaries(resolve)).toEqual({
      claude: true,
      codex: false,
      hermes: false,
      kilo: true,
      kimi: false,
    });
  });

  it("probes exactly the READINESS_AGENTS set (no shell, no extras)", () => {
    const asked: string[] = [];
    detectAgentBinaries((name) => {
      asked.push(name);
      return null;
    });
    expect(asked).toEqual([...READINESS_AGENTS]);
  });
});

describe("hasAgentAuthEvidence (injected fs)", () => {
  const home = () => path.join("H:", "users", "me");

  it("is true when any known sign-in marker exists", () => {
    for (const segments of AUTH_EVIDENCE_FILES) {
      const marker = path.join(home(), ...segments);
      expect(hasAgentAuthEvidence((p) => p === marker, home)).toBe(true);
    }
  });

  it("is false when nothing exists, and swallows a throwing exists()", () => {
    expect(hasAgentAuthEvidence(() => false, home)).toBe(false);
    expect(
      hasAgentAuthEvidence(() => {
        throw new Error("EACCES");
      }, home)
    ).toBe(false);
  });

  it("the default probe is FILE-typed: a directory named like a marker is not evidence", () => {
    // fileExists stats and requires isFile() — a folder called .claude.json
    // (accidental or planted) must not read as signed-in. Uses a real temp dir
    // so the DEFAULT probe (not an injected one) is exercised, 3-OS safe.
    const dir = mkdtempSync(path.join(tmpdir(), "stoa-readiness-"));
    try {
      const asDir = path.join(dir, ".claude.json");
      mkdirSync(asDir);
      expect(fileExists(asDir)).toBe(false);
      const asFile = path.join(dir, "real.json");
      writeFileSync(asFile, "{}");
      expect(fileExists(asFile)).toBe(true);
      expect(fileExists(path.join(dir, "missing.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("collectReadiness (fully injected)", () => {
  it("assembles the payload from the probes", () => {
    const present = new Set(["codex", "gh"]);
    const payload = collectReadiness({
      resolve: (name) => (present.has(name) ? `C:\\bin\\${name}.cmd` : null),
      exists: (p) => p.endsWith(path.join(".codex", "auth.json")),
      home: () => path.join("H:", "users", "me"),
    });
    expect(payload).toEqual({
      agents: {
        claude: false,
        codex: true,
        hermes: false,
        kilo: false,
        kimi: false,
      },
      gh: true,
      authHint: true,
    });
  });
});
