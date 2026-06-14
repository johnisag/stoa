import { describe, it, expect } from "vitest";

import {
  backendKeyForSession,
  sessionKey,
  type ProviderId,
} from "@/lib/providers/registry";

// Regression guard for the R4 review finding: the last-reply and claude-session
// routes built the live-session backend key with the bare
// sessionKey({ kind: "agent", provider, id }) = "<provider>-<id>". After
// PATCH /api/sessions/[id] renames the live backend session to a sanitized
// display name stored in session.tmux_name, that canonical key no longer
// addresses the running pty/tmux:
//   - last-reply: backend.getPanePath misses and the cwd falls back to a stale
//     working_directory, so the wrong transcript dir is read.
//   - claude-session: backend.getEnv(CLAUDE_SESSION_ID) addresses the dead key
//     and never reads the live id.
//
// Both routes now delegate to backendKeyForSession(session) (matching the
// send-keys/summarize/respond/DELETE routes), which prefers the stored
// tmux_name. These assertions lock that the authoritative key honors a rename.
//
// Scope: this guards the resolver the routes now delegate to in a single line.
// It does not re-invoke the route handlers (which need a live backend + db), so
// it would not catch a revert of a route's call site itself — that one-line
// delegation is covered by the typecheck. The resolver is the load-bearing rule.

describe("R4: claude transcript routes' backend key honors a renamed session", () => {
  it("resolves to the stored tmux_name, not the canonical {provider}-{id}", () => {
    const session: {
      id: string;
      agent_type: ProviderId;
      tmux_name: string | null;
    } = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      agent_type: "claude",
      tmux_name: "my-renamed-session",
    };

    const canonical = sessionKey({
      kind: "agent",
      provider: session.agent_type,
      id: session.id,
    });

    // The old (buggy) computation and the renamed key must differ — otherwise the
    // test couldn't distinguish the regression.
    expect(canonical).toBe("claude-550e8400-e29b-41d4-a716-446655440000");
    expect(canonical).not.toBe(session.tmux_name);

    // The routes now address the pty by the stored tmux_name.
    expect(backendKeyForSession(session)).toBe("my-renamed-session");
  });

  it("falls back to the canonical claude key when never renamed", () => {
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
