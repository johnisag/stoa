/**
 * OS sandbox launch tier (#27) — the pure argv transform + policy + detection.
 * Contract: it is ADDITIVE (byte-identical to pre-#27 for any mode but
 * sandboxed-auto, or when no primitive is present), it never runs a real
 * sandbox binary (detection is injected), and untrusted paths ride as discrete
 * argv tokens (no shell, no injection).
 */
import { describe, it, expect } from "vitest";
import { wrapSpawnForSandbox } from "@/lib/sandbox/wrap";
import { computeRwRoots } from "@/lib/sandbox/policy";
import { detectSandboxTool } from "@/lib/sandbox/detect";
import { coerceApprovalMode } from "@/lib/sandbox/types";
import {
  decideWorkerSandbox,
  effectiveSandboxActive,
} from "@/lib/sandbox/worker";

const SPAWN = { file: "claude", args: ["--resume", "abc", "-p", "do it"] };
const POLICY = { rwRoots: ["/wt/a"], allowNet: true };
// A detector that always reports bwrap present (no real binary touched).
const bwrapPresent = () => ({ tool: "bwrap" as const, path: "/usr/bin/bwrap" });
const nonePresent = () => null;

describe("wrapSpawnForSandbox — additivity (tier-off is byte-identical)", () => {
  for (const mode of ["prompt", "full-bypass"] as const) {
    it(`is a pass-through for mode="${mode}"`, () => {
      const w = wrapSpawnForSandbox(SPAWN, mode, POLICY, {
        platform: "linux",
        detect: bwrapPresent,
      });
      expect(w.argsPrefix).toEqual([]);
      expect(w.file).toBe("claude");
      expect(w.downgraded).toBe(false);
      expect(w.tool).toBe("none");
    });
  }
});

describe("wrapSpawnForSandbox — sandboxed-auto with bwrap", () => {
  it("emits the exact bwrap argv prefix (net allowed)", () => {
    const w = wrapSpawnForSandbox(
      SPAWN,
      "sandboxed-auto",
      { rwRoots: ["/wt/a", "/main/.git", "/home/u/.stoa"], allowNet: true },
      { platform: "linux", detect: bwrapPresent }
    );
    expect(w.file).toBe("/usr/bin/bwrap");
    expect(w.tool).toBe("bwrap");
    expect(w.downgraded).toBe(false);
    expect(w.argsPrefix).toEqual([
      "--die-with-parent",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--bind",
      "/wt/a",
      "/wt/a",
      "--bind",
      "/main/.git",
      "/main/.git",
      "--bind",
      "/home/u/.stoa",
      "/home/u/.stoa",
      "--",
    ]);
    // The caller composes: [bwrap, ...prefix, originalFile, ...originalArgs].
    const full = [w.file, ...w.argsPrefix, SPAWN.file, ...SPAWN.args];
    expect(full).toContain("claude");
    expect(full[full.indexOf("--") + 1]).toBe("claude");
  });

  it("adds --unshare-net when net is denied", () => {
    const w = wrapSpawnForSandbox(
      SPAWN,
      "sandboxed-auto",
      { rwRoots: ["/wt/a"], allowNet: false },
      { platform: "linux", detect: bwrapPresent }
    );
    expect(w.argsPrefix).toContain("--unshare-net");
    // net-off token sits before the "--" terminator.
    expect(w.argsPrefix.indexOf("--unshare-net")).toBeLessThan(
      w.argsPrefix.lastIndexOf("--")
    );
  });

  it("keeps an untrusted rwRoot as ONE discrete token (no shell, no split)", () => {
    const evil = "/tmp/a b; rm -rf ~ $(whoami)";
    const w = wrapSpawnForSandbox(
      SPAWN,
      "sandboxed-auto",
      { rwRoots: [evil], allowNet: true },
      { platform: "linux", detect: bwrapPresent }
    );
    // Appears verbatim, exactly twice (--bind src dst), never split or interpreted.
    expect(w.argsPrefix.filter((t) => t === evil)).toHaveLength(2);
  });
});

describe("wrapSpawnForSandbox — fail-safe fallback (downgrade, never throw)", () => {
  it("passes through + downgrades when no primitive is present (linux, no bwrap)", () => {
    const w = wrapSpawnForSandbox(SPAWN, "sandboxed-auto", POLICY, {
      platform: "linux",
      detect: nonePresent,
    });
    expect(w.argsPrefix).toEqual([]);
    expect(w.file).toBe("claude");
    expect(w.downgraded).toBe(true);
    expect(w.effectiveMode).toBe("prompt"); // fails closed to the safe mode
  });

  for (const platform of ["darwin", "win32"] as const) {
    it(`passes through + downgrades on ${platform} (no wrapper shipped)`, () => {
      const w = wrapSpawnForSandbox(SPAWN, "sandboxed-auto", POLICY, {
        platform,
      });
      expect(w.argsPrefix).toEqual([]);
      expect(w.downgraded).toBe(true);
    });
  }
});

describe("computeRwRoots", () => {
  it("de-dups and orders worktree(s) + git-common-dir + stoa home", () => {
    expect(
      computeRwRoots({
        worktreePaths: ["/wt/a", "/wt/b", "/wt/a"],
        gitCommonDir: "/main/.git",
        stoaHome: "/home/u/.stoa",
      })
    ).toEqual(["/wt/a", "/wt/b", "/main/.git", "/home/u/.stoa"]);
  });

  it("tolerates a null git-common-dir (non-repo cwd)", () => {
    expect(
      computeRwRoots({
        worktreePaths: ["/wt/a"],
        gitCommonDir: null,
        stoaHome: "/home/u/.stoa",
      })
    ).toEqual(["/wt/a", "/home/u/.stoa"]);
  });

  it("includes the agent's own state dir rw (so it can write its transcript)", () => {
    // A read-only ~/.claude breaks Claude's rollout/transcript writes → the
    // whole cost/resume/fork/checkpoint pipeline. It MUST be writable.
    expect(
      computeRwRoots({
        worktreePaths: ["/wt/a"],
        gitCommonDir: "/main/.git",
        agentConfigDir: "/home/u/.claude",
        stoaHome: "/home/u/.stoa",
      })
    ).toEqual(["/wt/a", "/main/.git", "/home/u/.claude", "/home/u/.stoa"]);
  });
});

describe("effectiveSandboxActive (fail-closed flag/wrap coupling)", () => {
  it("is active only when the gate says active AND the wrap did not downgrade", () => {
    expect(effectiveSandboxActive(true, false)).toBe(true);
    // A wrap downgrade withdraws the bypass flag → the worker prompts, never
    // runs unattended-and-unconfined.
    expect(effectiveSandboxActive(true, true)).toBe(false);
    expect(effectiveSandboxActive(false, false)).toBe(false);
  });
});

describe("detectSandboxTool (injected detector — no real binary)", () => {
  it("returns bwrap on linux when present, null when absent", () => {
    expect(detectSandboxTool("linux", () => "/usr/bin/bwrap")).toEqual({
      tool: "bwrap",
      path: "/usr/bin/bwrap",
    });
    expect(detectSandboxTool("linux", () => null)).toBeNull();
  });
  it("returns null on darwin + win32 (no PR1 wrapper)", () => {
    expect(
      detectSandboxTool("darwin", () => "/usr/bin/sandbox-exec")
    ).toBeNull();
    expect(detectSandboxTool("win32", () => "x")).toBeNull();
  });
});

describe("coerceApprovalMode (fail-closed)", () => {
  it("accepts the three modes, weakens anything else to 'prompt'", () => {
    for (const m of ["prompt", "sandboxed-auto", "full-bypass"]) {
      expect(coerceApprovalMode(m)).toBe(m);
    }
    for (const bad of [null, undefined, "", "bypass", "Full-Bypass", 1, {}]) {
      expect(coerceApprovalMode(bad)).toBe("prompt");
    }
  });
});

describe("decideWorkerSandbox", () => {
  it("engages sandboxed-auto when opt-in + primitive", () => {
    expect(
      decideWorkerSandbox({
        sandboxEnabled: true,
        detected: true,
      })
    ).toEqual({ approvalMode: "sandboxed-auto", sandboxActive: true });
  });

  it("stays full-bypass with no opt-in or no primitive", () => {
    const cases = [
      { sandboxEnabled: false, detected: true },
      { sandboxEnabled: true, detected: false },
    ];
    for (const c of cases) {
      expect(decideWorkerSandbox(c)).toEqual({
        approvalMode: "full-bypass",
        sandboxActive: false,
      });
    }
  });

  it("engages on tmux too now that command-string wrapping is wired", () => {
    expect(
      decideWorkerSandbox({
        sandboxEnabled: true,
        detected: true,
      })
    ).toEqual({ approvalMode: "sandboxed-auto", sandboxActive: true });
  });
});
