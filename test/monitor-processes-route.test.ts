import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProcInfo } from "@/lib/process-tree";
import type { PortOwner } from "@/lib/listening-ports";

// Drive the route with controlled sessions, a controlled live-list + pid resolver, a
// controlled process snapshot, and a controlled listening-port snapshot — but let the
// REAL fanoutFor / attributePorts / backendKeyForSession run, so the test exercises the
// route's actual orchestration (live filtering, pid→tree mapping, port attribution).
const state = vi.hoisted(() => ({
  sessions: [] as Array<{
    id: string;
    tmux_name: string | null;
    agent_type: string;
    dev_server_port?: number | null;
    project_id?: string | null;
  }>,
  procs: [] as ProcInfo[],
  ports: [] as PortOwner[],
  devServers: [] as Array<{ project_id: string; ports: string | null }>,
}));
const backend = vi.hoisted(() => ({
  list: vi.fn(async (): Promise<string[]> => []),
  getPid: vi.fn(async (_key: string): Promise<number | null> => null),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  queries: {
    getAllSessions: () => ({ all: () => state.sessions }),
    getAllDevServers: () => ({ all: () => state.devServers }),
  },
}));
vi.mock("@/lib/session-backend", () => ({ getSessionBackend: () => backend }));
vi.mock("@/lib/process-tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/process-tree")>();
  return { ...actual, snapshotProcesses: vi.fn(async () => state.procs) };
});
vi.mock("@/lib/listening-ports", () => ({
  listListeningPorts: vi.fn(async () => state.ports),
}));

import { GET } from "@/app/api/monitor/processes/route";

beforeEach(() => {
  state.sessions = [];
  state.procs = [];
  state.ports = [];
  state.devServers = [];
  backend.list.mockReset().mockResolvedValue([]);
  backend.getPid.mockReset().mockResolvedValue(null);
});

describe("GET /api/monitor/processes (M3 + M4)", () => {
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
      ports: [],
    });
    expect(body.fanouts.s2).toBeUndefined(); // dead row → not inspected
  });

  it("attributes listening ports to the owning session and flags orphans (M4)", async () => {
    state.sessions = [
      {
        id: "s1",
        tmux_name: "claude-1",
        agent_type: "claude",
        dev_server_port: 3000,
      },
    ];
    state.procs = [
      { pid: 100, ppid: 1, command: "pty-root" },
      { pid: 101, ppid: 100, command: "vite" },
    ];
    state.ports = [
      { port: 3000, pid: 101 }, // matches the session's assigned dev_server_port → known
      { port: 8080, pid: 101 }, // agent opened it; Stoa unaware → orphan
      { port: 9999, pid: 555 }, // unrelated process → not attributed
    ];
    backend.list.mockResolvedValue(["claude-1"]);
    backend.getPid.mockResolvedValue(100);

    const body = await (await GET()).json();
    expect(body.fanouts.s1.ports).toEqual([
      { port: 3000, orphan: false }, // assigned dev_server_port → known
      { port: 8080, orphan: true }, // orphan
    ]);
  });

  it("treats a managed dev-server port (same project) as NOT an orphan", async () => {
    state.sessions = [
      {
        id: "s1",
        tmux_name: "claude-1",
        agent_type: "claude",
        project_id: "p1",
      },
    ];
    state.devServers = [{ project_id: "p1", ports: "[5173]" }]; // Stoa manages 5173 for p1
    state.procs = [
      { pid: 100, ppid: 1, command: "pty-root" },
      { pid: 101, ppid: 100, command: "vite" },
    ];
    state.ports = [{ port: 5173, pid: 101 }];
    backend.list.mockResolvedValue(["claude-1"]);
    backend.getPid.mockResolvedValue(100);

    const body = await (await GET()).json();
    expect(body.fanouts.s1.ports).toEqual([{ port: 5173, orphan: false }]);
  });

  it("does NOT let one session's tracked port mask another session's orphan (Gate D)", async () => {
    // Session A's assigned port is 5173; session B's agent independently binds 5173.
    // B's 5173 must still read as an orphan — the managed set is PER-SESSION, not global.
    state.sessions = [
      {
        id: "A",
        tmux_name: "claude-A",
        agent_type: "claude",
        project_id: "pa",
        dev_server_port: 5173,
      },
      {
        id: "B",
        tmux_name: "claude-B",
        agent_type: "claude",
        project_id: "pb",
      },
    ];
    state.procs = [
      { pid: 100, ppid: 1, command: "pty-A" },
      { pid: 200, ppid: 1, command: "pty-B" },
      { pid: 201, ppid: 200, command: "rogue-server" },
    ];
    state.ports = [{ port: 5173, pid: 201 }]; // listening under B's tree
    backend.list.mockResolvedValue(["claude-A", "claude-B"]);
    backend.getPid.mockImplementation(async (k) =>
      k === "claude-A" ? 100 : k === "claude-B" ? 200 : null
    );

    const body = await (await GET()).json();
    expect(body.fanouts.B.ports).toEqual([{ port: 5173, orphan: true }]); // not masked by A
    expect(body.fanouts.A.ports).toEqual([]); // A's tree isn't listening
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
    expect(body.fanouts.s1).toEqual({
      childCount: 0,
      mcpServers: [],
      ports: [],
    });
  });
});
