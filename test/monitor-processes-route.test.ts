import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProcInfo } from "@/lib/process-tree";

// Drive the route with controlled sessions, a controlled live-list + pid resolver, and a
// controlled process snapshot — but let the REAL fanoutFor / backendKeyForSession run, so
// the test exercises the route's actual orchestration (live filtering, pid→tree mapping).
const state = vi.hoisted(() => ({
  sessions: [] as Array<{
    id: string;
    tmux_name: string | null;
    agent_type: string;
  }>,
  procs: [] as ProcInfo[],
}));
const backend = vi.hoisted(() => ({
  list: vi.fn(async (): Promise<string[]> => []),
  getPid: vi.fn(async (_key: string): Promise<number | null> => null),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  queries: { getAllSessions: () => ({ all: () => state.sessions }) },
}));
vi.mock("@/lib/session-backend", () => ({ getSessionBackend: () => backend }));
vi.mock("@/lib/process-tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/process-tree")>();
  return { ...actual, snapshotProcesses: vi.fn(async () => state.procs) };
});

import { GET } from "@/app/api/monitor/processes/route";

beforeEach(() => {
  state.sessions = [];
  state.procs = [];
  backend.list.mockReset().mockResolvedValue([]);
  backend.getPid.mockReset().mockResolvedValue(null);
});

describe("GET /api/monitor/processes (M3)", () => {
  it("computes fan-out only for LIVE sessions and maps each pid to its subtree", async () => {
    state.sessions = [
      { id: "s1", tmux_name: "claude-1", agent_type: "claude" },
      { id: "s2", tmux_name: "claude-2", agent_type: "claude" }, // not live
    ];
    state.procs = [
      { pid: 100, ppid: 1, command: "pty-root" },
      { pid: 101, ppid: 100, command: "claude" },
      { pid: 102, ppid: 101, command: "npx mcp-server-git" },
    ];
    backend.list.mockResolvedValue(["claude-1"]); // only s1 is live
    backend.getPid.mockImplementation(async (k) =>
      k === "claude-1" ? 100 : null
    );

    const body = await (await GET()).json();
    expect(body.fanouts.s1).toEqual({
      childCount: 2,
      mcpServers: ["mcp-server-git"],
    });
    expect(body.fanouts.s2).toBeUndefined(); // dead row → not inspected
  });

  it("fails closed when the backend can't list sessions (no fan-outs, no throw)", async () => {
    state.sessions = [
      { id: "s1", tmux_name: "claude-1", agent_type: "claude" },
    ];
    backend.list.mockRejectedValue(new Error("backend down"));

    const body = await (await GET()).json();
    expect(body.fanouts).toEqual({});
  });

  it("gives a live session whose pid can't be resolved a zero fan-out", async () => {
    state.sessions = [
      { id: "s1", tmux_name: "claude-1", agent_type: "claude" },
    ];
    backend.list.mockResolvedValue(["claude-1"]);
    backend.getPid.mockResolvedValue(null); // unresolved root pid

    const body = await (await GET()).json();
    expect(body.fanouts.s1).toEqual({ childCount: 0, mcpServers: [] });
  });
});
