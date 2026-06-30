/**
 * Conversation fork helpers (#11) — the per-provider fork mode + the scrollback
 * seed for providers without a native fork. Plus a regression that buildAgentArgs
 * / the tmux buildFlags never emit --fork-session for a non-fork provider.
 */
import { describe, it, expect } from "vitest";
import {
  forkModeForProvider,
  sanitizeForkScrollback,
  buildForkSeed,
  resolveNativeForkParentId,
  FORK_SEED_MAX_LENGTH,
} from "@/lib/fork";
import { buildAgentArgs, getProvider } from "@/lib/providers";
import type { Session } from "@/lib/db";

/** Minimal Session — only the fields resolveNativeForkParentId reads matter. */
function session(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    parent_session_id: null,
    claude_session_id: null,
    agent_type: "claude",
    ...over,
  } as Session;
}

describe("forkModeForProvider", () => {
  it("is native for Claude (it has --fork-session), scrollback for the rest", () => {
    expect(forkModeForProvider("claude")).toBe("native");
    expect(forkModeForProvider("codex")).toBe("scrollback");
    expect(forkModeForProvider("hermes")).toBe("scrollback");
    expect(forkModeForProvider("kilo")).toBe("scrollback");
    expect(forkModeForProvider("kimi")).toBe("scrollback");
  });

  it("is null for the plain shell and unknown providers (nothing to fork)", () => {
    expect(forkModeForProvider("shell")).toBeNull();
    expect(forkModeForProvider("nope")).toBeNull();
  });
});

describe("sanitizeForkScrollback", () => {
  it("strips ANSI/control bytes but keeps text, tabs, and newlines", () => {
    const dirty = "a\x1b[31mred\x1b[0m\tb\nc\x07\x00d";
    expect(sanitizeForkScrollback(dirty)).toBe("ared\tb\ncd");
  });

  it("collapses blank-line runs and trims", () => {
    expect(sanitizeForkScrollback("x\n\n\n\ny  \n")).toBe("x\n\ny");
  });

  it("strips OSC strings and DEC-private CSI, and turns CRLF into LF", () => {
    expect(sanitizeForkScrollback("a\x1b]0;title\x07b")).toBe("ab"); // OSC + BEL
    expect(sanitizeForkScrollback("a\x1b[?25lb")).toBe("ab"); // DEC private CSI
    expect(sanitizeForkScrollback("line1\r\nline2")).toBe("line1\nline2"); // CR dropped
  });
});

describe("buildForkSeed", () => {
  it("frames the recent transcript as a continue-from-here prompt", () => {
    const seed = buildForkSeed("did the thing\nthen the next", "my-agent");
    expect(seed).toContain('forked from "my-agent"');
    expect(seed).toContain("continue from where it left off");
    expect(seed).toContain("did the thing");
    expect(seed).toContain("----- transcript -----");
  });

  it("returns '' for empty/whitespace-only scrollback (degrade to a plain fork)", () => {
    expect(buildForkSeed("", "x")).toBe("");
    expect(buildForkSeed("   \n  \n", "x")).toBe("");
    expect(buildForkSeed("\x1b[0m\x07", "x")).toBe(""); // all control bytes
  });

  it("keeps only the most-recent tail when the scrollback is huge", () => {
    const huge =
      "OLD".repeat(2) + "x".repeat(FORK_SEED_MAX_LENGTH + 5000) + "RECENT-TAIL";
    const seed = buildForkSeed(huge, "a");
    expect(seed).toContain("RECENT-TAIL"); // the end is kept
    expect(seed).not.toContain("OLDOLD"); // the start is dropped
  });
});

describe("resolveNativeForkParentId (#8 — re-attach before first turn)", () => {
  const parent = session({ id: "p", claude_session_id: "parent-cid" });

  it("returns the parent's conversation id for a not-yet-started native fork", () => {
    const fork = session({
      id: "f",
      parent_session_id: "p",
      agent_type: "claude",
    });
    expect(resolveNativeForkParentId(fork, [parent, fork])).toBe("parent-cid");
  });

  it("returns null once the fork has its OWN claude_session_id (already started)", () => {
    const fork = session({
      id: "f",
      parent_session_id: "p",
      claude_session_id: "own-cid",
    });
    expect(resolveNativeForkParentId(fork, [parent, fork])).toBeNull();
  });

  it("returns null when there is no parent (not a fork)", () => {
    expect(resolveNativeForkParentId(session(), [parent])).toBeNull();
  });

  it("returns null for a NON-native (scrollback) provider — must NOT resume the parent", () => {
    // Codex forks via scrollback; resuming the parent here would continue the
    // parent's conversation and emit an invalid --fork-session.
    const fork = session({
      id: "f",
      parent_session_id: "p",
      agent_type: "codex",
    });
    expect(resolveNativeForkParentId(fork, [parent, fork])).toBeNull();
  });

  it("returns null when the parent is gone or has no conversation id yet", () => {
    const fork = session({ id: "f", parent_session_id: "p" });
    expect(resolveNativeForkParentId(fork, [fork])).toBeNull(); // parent absent
    const parentNoCid = session({ id: "p", claude_session_id: null });
    expect(resolveNativeForkParentId(fork, [parentNoCid, fork])).toBeNull();
  });
});

describe("buildAgentArgs fork gating (regression)", () => {
  it("emits --resume + --fork-session for a Claude fork", () => {
    const { args } = buildAgentArgs("claude", {
      parentSessionId: "parent-abc",
    });
    expect(args).toContain("--resume");
    expect(args).toContain("parent-abc");
    expect(args).toContain("--fork-session");
  });

  it("a non-fork provider IGNORES parentSessionId entirely — no --fork-session AND no --resume of the parent", () => {
    // hermes/kimi/kilo HAVE a resumeFlag, so this guards that the parent-fork
    // branch is gated on supportsFork (it must never resume the PARENT's session).
    for (const p of ["codex", "hermes", "kilo", "kimi"] as const) {
      const { args } = buildAgentArgs(p, { parentSessionId: "parent-abc" });
      expect(args).not.toContain("--fork-session");
      expect(args).not.toContain("parent-abc");
    }
  });

  it("the tmux buildFlags path is identically gated (no --fork-session, no parent resume)", () => {
    for (const p of ["codex", "hermes", "kilo", "kimi"] as const) {
      const joined = getProvider(p)
        .buildFlags({ parentSessionId: "parent-abc" })
        .join(" ");
      expect(joined).not.toContain("--fork-session");
      expect(joined).not.toContain("parent-abc");
    }
    // Claude's tmux path still forks natively.
    const claude = getProvider("claude")
      .buildFlags({ parentSessionId: "parent-abc" })
      .join(" ");
    expect(claude).toContain("--fork-session");
    expect(claude).toContain("parent-abc");
  });
});
