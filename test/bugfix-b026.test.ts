import { describe, it, expect } from "vitest";

import {
  backendKeyForSession,
  sessionKey,
  type ProviderId,
} from "@/lib/providers/registry";

// Regression test for B026: the send-keys route computed the backend key with
// sessionKey({ kind: "agent", provider, id }) = "<provider>-<id>". After
// PATCH /api/sessions/[id] renames the live backend session to a sanitized
// display name stored in session.tmux_name, that canonical key no longer
// addresses the running pty/tmux — backend.exists() returns false and the route
// 400s with "Tmux session not running", breaking SnapshotTimeline prompt
// dispatch for renamed sessions.
//
// The fix routes the send-keys handler through backendKeyForSession(session)
// (matching the DELETE/respond/ceremony routes), which prefers the stored
// tmux_name. These assertions lock that the authoritative key honors a rename.
//
// Scope: this guards the resolver the route now delegates to in a single line.
// It does not re-invoke the route handler (which needs a live backend + db), so
// it would not catch a revert of the route's call site itself — that one-line
// delegation is covered by the typecheck. The resolver is the load-bearing rule.

describe("B026: send-keys backend key honors a renamed session's tmux_name", () => {
  it("resolves to the stored tmux_name, not the canonical {provider}-{id}", () => {
    const session: {
      id: string;
      agent_type: ProviderId;
      tmux_name: string | null;
    } = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      agent_type: "codex",
      tmux_name: "my-renamed-session",
    };

    const canonical = sessionKey({
      kind: "agent",
      provider: session.agent_type,
      id: session.id,
    });

    // The old (buggy) computation and the renamed key must differ — otherwise the
    // test couldn't distinguish the regression.
    expect(canonical).toBe("codex-550e8400-e29b-41d4-a716-446655440000");
    expect(canonical).not.toBe(session.tmux_name);

    // The route now addresses the pty by the stored tmux_name.
    expect(backendKeyForSession(session)).toBe("my-renamed-session");
  });

  it("falls back to the canonical key when the session was never renamed", () => {
    const session = {
      id: "abc",
      agent_type: "claude",
      tmux_name: null as string | null,
    };
    expect(backendKeyForSession(session)).toBe(
      sessionKey({ kind: "agent", provider: "claude", id: "abc" })
    );
    expect(backendKeyForSession(session)).toBe("claude-abc");
  });
});
