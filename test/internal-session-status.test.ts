import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  sessions: [] as Array<{
    id: string;
    tmux_name: string;
    agent_type: string;
    session_role: string | null;
  }>,
  dbError: null as Error | null,
  list: vi.fn<() => Promise<string[]>>(),
  captureStatus: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  queries: {
    getAllSessions: () => ({
      all: () => {
        if (state.dbError) throw state.dbError;
        return state.sessions;
      },
    }),
  },
}));

vi.mock("@/lib/session-backend", () => ({
  getSessionBackend: () => ({ list: state.list }),
}));

vi.mock("@/lib/status-detector", () => ({
  statusDetector: { getStatusDetail: state.captureStatus },
}));

import { computeManagedStatuses } from "@/lib/session-status";

const ORDINARY_ID = "11111111-1111-4111-8111-111111111111";
const SUPERVISOR_ID = "22222222-2222-4222-8222-222222222222";

describe("internal session status isolation", () => {
  beforeEach(() => {
    state.dbError = null;
    state.sessions = [
      {
        id: ORDINARY_ID,
        tmux_name: `claude-${ORDINARY_ID}`,
        agent_type: "claude",
        session_role: "interactive",
      },
      {
        id: SUPERVISOR_ID,
        tmux_name: `claude-${SUPERVISOR_ID}`,
        agent_type: "claude",
        session_role: "fleet_supervisor",
      },
    ];
    state.list
      .mockReset()
      .mockResolvedValue([`claude-${ORDINARY_ID}`, `claude-${SUPERVISOR_ID}`]);
    state.captureStatus.mockReset().mockResolvedValue({
      status: "running",
      lastLine: "visible",
      rateLimit: null,
      prompt: null,
    });
  });

  it("never captures or broadcasts a server-owned broker session", async () => {
    await expect(computeManagedStatuses()).resolves.toEqual([
      {
        id: ORDINARY_ID,
        name: `claude-${ORDINARY_ID}`,
        status: "running",
        lastLine: "visible",
        rateLimit: null,
        prompt: null,
      },
    ]);
    expect(state.captureStatus).toHaveBeenCalledTimes(1);
    expect(state.captureStatus).toHaveBeenCalledWith(`claude-${ORDINARY_ID}`);
  });

  it("fails closed before enumerating terminals when ownership cannot be read", async () => {
    state.dbError = new Error("database unavailable");

    await expect(computeManagedStatuses()).resolves.toEqual([]);
    expect(state.list).not.toHaveBeenCalled();
    expect(state.captureStatus).not.toHaveBeenCalled();
  });
});
