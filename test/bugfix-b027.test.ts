import { describe, it, expect } from "vitest";

import { backendKeyForSession, sessionKey } from "@/lib/providers/registry";

// Regression test for B027: the summarize route (GET + POST) computed the
// EXISTING session's backend key as a bare sessionKey({provider, id}). After a
// rename the live session lives under session.tmux_name, so that bare key missed
// the running pty/tmux and the digest degraded to working_directory-only. The fix
// resolves the existing session via backendKeyForSession(session), which prefers
// the stored tmux_name. These assertions pin that rename-aware behavior.
//
// Scope: this guards the resolver both summarize handlers now delegate to; it
// does not re-invoke the route (which needs a live backend + db). The one-line
// call-site delegation is covered by the typecheck; the resolver is the rule.

describe("B027: existing-session key resolution survives a rename", () => {
  const id = "11111111-2222-3333-4444-555555555555";

  it("prefers the live tmux_name over the canonical {provider}-{id}", () => {
    const renamed = {
      id,
      agent_type: "claude",
      // Live name after a rename — no longer matches `claude-<id>`.
      tmux_name: "claude-renamed-handle",
    };
    expect(backendKeyForSession(renamed)).toBe("claude-renamed-handle");
    // The old code path (bare sessionKey) would have missed the live session.
    expect(backendKeyForSession(renamed)).not.toBe(
      sessionKey({ kind: "agent", provider: "claude", id })
    );
  });

  it("falls back to the canonical key when tmux_name is absent", () => {
    expect(
      backendKeyForSession({ id, agent_type: "claude", tmux_name: null })
    ).toBe(sessionKey({ kind: "agent", provider: "claude", id }));
  });

  it("normalizes an unknown/empty agent_type to the claude fallback", () => {
    // Guards against a malformed "-<id>" key when agent_type is missing.
    expect(backendKeyForSession({ id, agent_type: "", tmux_name: null })).toBe(
      `claude-${id}`
    );
    expect(
      backendKeyForSession({ id, agent_type: "bogus", tmux_name: null })
    ).toBe(`claude-${id}`);
  });

  it("keeps a non-claude provider's canonical key when not renamed", () => {
    expect(
      backendKeyForSession({ id, agent_type: "codex", tmux_name: null })
    ).toBe(sessionKey({ kind: "agent", provider: "codex", id }));
  });
});
