import { describe, it, expect } from "vitest";
import type { SessionStatus } from "@/components/views/types";
import { applyStatusDeltas } from "@/data/statuses/apply-deltas";

const ID = "12345678-1234-1234-1234-123456789abc";

function cached(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    sessionName: `kimi-${ID}`,
    status: "idle",
    lastLine: "",
    claudeSessionId: null,
    cwd: null,
    ...overrides,
  };
}

describe("applyStatusDeltas — shared status-cache merge", () => {
  it("preserves the live cwd from the cached entry (Files-view root must not flap on a pushed delta)", () => {
    const live = "C:\\work\\.stoa\\worktrees\\feat-x";
    const next = applyStatusDeltas({ [ID]: cached({ cwd: live }) }, [
      { id: ID, name: `kimi-${ID}`, status: "running", lastLine: "…" },
    ]);
    expect(next[ID].cwd).toBe(live);
  });

  it("preserves the cached claudeSessionId the same way", () => {
    const next = applyStatusDeltas(
      { [ID]: cached({ claudeSessionId: "sess-1" }) },
      [{ id: ID, name: `kimi-${ID}`, status: "waiting", lastLine: "" }]
    );
    expect(next[ID].claudeSessionId).toBe("sess-1");
  });

  it("defaults cwd and claudeSessionId to null for a session not yet cached", () => {
    const next = applyStatusDeltas({}, [
      { id: ID, name: `kimi-${ID}`, status: "idle", lastLine: "" },
    ]);
    expect(next[ID].cwd).toBeNull();
    expect(next[ID].claudeSessionId).toBeNull();
  });

  it("applies the pushed fields and leaves other sessions untouched", () => {
    const other = "99999999-9999-9999-9999-999999999999";
    const next = applyStatusDeltas(
      {
        [ID]: cached(),
        [other]: cached({ status: "running", lastLine: "busy" }),
      },
      [
        {
          id: ID,
          name: `kimi-${ID}`,
          status: "error",
          lastLine: "boom",
          rateLimit: null,
          hasPrompt: true,
        },
      ]
    );
    expect(next[ID].status).toBe("error");
    expect(next[ID].lastLine).toBe("boom");
    expect(next[ID].hasPrompt).toBe(true);
    expect(next[other].status).toBe("running");
    expect(next[other].lastLine).toBe("busy");
  });
});
