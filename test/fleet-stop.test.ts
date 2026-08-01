import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  session: {
    id: "session-1",
    tmux_name: "codex-session-1",
    agent_type: "codex",
    worker_status: "working" as string | null,
  },
  backendExists: false,
}));

const killWorker = vi.hoisted(() =>
  vi.fn(async (_id: string, _cleanup: boolean, finalStatus: string) => {
    state.session.worker_status = finalStatus;
  })
);

vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  queries: {
    getSession: () => ({ get: () => state.session }),
    updateWorkerStatus: () => ({
      run: (status: string | null) => {
        state.session.worker_status = status;
      },
    }),
  },
}));
vi.mock("@/lib/orchestration", () => ({ killWorker }));
vi.mock("@/lib/providers/registry", () => ({
  backendKeyForSession: () => "codex-session-1",
}));
vi.mock("@/lib/session-backend", () => ({
  getSessionBackend: () => ({ exists: async () => state.backendExists }),
}));

import { stopFleetSession } from "@/lib/fleet/stop";

beforeEach(() => {
  killWorker.mockClear();
  state.session.worker_status = "working";
  state.backendExists = false;
});

describe("stopFleetSession", () => {
  it("persists the intended completed status after verified shutdown", async () => {
    expect(await stopFleetSession("session-1", "completed")).toBe(true);
    expect(killWorker).toHaveBeenCalledWith("session-1", false, "completed");
    expect(state.session.worker_status).toBe("completed");
  });

  it("restores the prior status when shutdown cannot be verified", async () => {
    state.backendExists = true;
    expect(await stopFleetSession("session-1", "failed")).toBe(false);
    expect(state.session.worker_status).toBe("working");
  });
});
