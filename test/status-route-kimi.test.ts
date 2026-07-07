import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Session } from "@/lib/db";

const state = {
  sessions: [] as Array<string | { name: string; activity: number | null }>,
  dbSessions: new Map<string, Session>(),
  kimiIds: new Map<string, string>(),
  codexThreadId: null as string | null,
  updateRuns: [] as unknown[][],
  statusDetailCalls: 0,
  getKimiSessionIdCalls: 0,
};

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    // run for the status/claude-id updates; get for the #19 verify-badge read
    // (undefined = no verdict — the route null-coalesces it).
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => {
        if (sql.includes("claude_session_id")) state.updateRuns.push(args);
      },
      get: (id: string) =>
        sql.includes("SELECT * FROM sessions")
          ? state.dbSessions.get(id)
          : undefined,
    }),
  }),
  queries: {
    getSession: (db: { prepare: (sql: string) => unknown }) =>
      db.prepare("SELECT * FROM sessions WHERE id = ?"),
  },
}));

vi.mock("@/lib/session-backend", () => ({
  getSessionBackend: () => ({
    list: async () =>
      state.sessions.map((s) => (typeof s === "string" ? s : s.name)),
    listWithActivity: async () =>
      state.sessions.map((s) =>
        typeof s === "string" ? { name: s, activity: null } : s
      ),
    getPanePath: async () => null,
    getEnv: async () => null,
  }),
}));

vi.mock("@/lib/status-detector", () => ({
  statusDetector: {
    getStatusDetail: async () => {
      state.statusDetailCalls++;
      return { status: "idle", lastLine: "", rateLimit: null, prompt: null };
    },
    cleanup: () => {},
    getKimiSessionId: (name: string) => {
      state.getKimiSessionIdCalls++;
      return state.kimiIds.get(name) ?? null;
    },
  },
}));

vi.mock("@/lib/codex-usage", () => ({
  resolveCodexThreadIdForSession: vi.fn(() => state.codexThreadId),
  markCodexThreadVerified: vi.fn(),
  clearCodexThreadVerification: vi.fn(),
}));

import { GET } from "@/app/api/sessions/status/route";
import {
  clearCodexThreadVerification,
  markCodexThreadVerified,
  resolveCodexThreadIdForSession,
} from "@/lib/codex-usage";

async function getBody(res: Response) {
  return (await res.json()) as { statuses: Record<string, unknown> };
}

describe("/api/sessions/status — Kimi branch", () => {
  beforeEach(() => {
    state.sessions = [];
    state.dbSessions.clear();
    state.kimiIds.clear();
    state.codexThreadId = null;
    state.updateRuns = [];
    state.statusDetailCalls = 0;
    state.getKimiSessionIdCalls = 0;
    vi.mocked(resolveCodexThreadIdForSession).mockClear();
    vi.mocked(markCodexThreadVerified).mockClear();
    vi.mocked(clearCodexThreadVerification).mockClear();
  });

  it("resolves and caches the Kimi banner session id", async () => {
    const id = "12345678-1234-1234-1234-123456789abc";
    const name = `kimi-${id}`;
    const bannerId = "session_ca9b5a60-f6da-47f8-b2fa-84805e8c8161";
    state.sessions = [name];
    state.kimiIds.set(name, bannerId);

    const res1 = await GET();
    expect(res1.status).toBe(200);
    const body1 = await getBody(res1);
    expect(body1.statuses[id]).toMatchObject({
      claudeSessionId: bannerId,
      agentType: "kimi",
    });
    expect(state.getKimiSessionIdCalls).toBe(1);

    // Second poll must reuse the cached resolved id, not call getKimiSessionId again.
    const res2 = await GET();
    expect(res2.status).toBe(200);
    const body2 = await getBody(res2);
    expect(body2.statuses[id]).toMatchObject({
      claudeSessionId: bannerId,
      agentType: "kimi",
    });
    expect(state.getKimiSessionIdCalls).toBe(1);
  });

  it("returns null claudeSessionId when Kimi has no banner id yet", async () => {
    const id = "aaaaaaaa-1111-2222-3333-444444444444";
    const name = `kimi-${id}`;
    state.sessions = [name];

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await getBody(res);
    expect(body.statuses[id]).toMatchObject({
      claudeSessionId: null,
      agentType: "kimi",
    });
  });

  it("resolves and persists the Codex thread id from live session activity", async () => {
    const id = "bbbbbbbb-1111-2222-3333-444444444444";
    const name = `codex-${id}`;
    const activity = 1_783_410_042;
    const row = {
      id,
      name: "Codex",
      tmux_name: name,
      created_at: "2026-07-07 10:00:00",
      updated_at: "2026-07-07 10:00:00",
      status: "idle",
      working_directory: "C:\\repo",
      parent_session_id: null,
      claude_session_id: null,
      model: "gpt-5.5",
      system_prompt: null,
      group_path: "",
      project_id: null,
      agent_type: "codex",
      auto_approve: false,
      worktree_path: null,
      branch_name: null,
      base_branch: null,
      dev_server_port: null,
      pr_url: null,
      pr_number: null,
      pr_status: null,
      conductor_session_id: null,
      worker_task: null,
      worker_status: null,
      mcp_launch_args: null,
    } as Session;
    state.sessions = [{ name, activity }];
    state.dbSessions.set(id, row);
    state.codexThreadId = "thread-abc";

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await getBody(res);
    expect(body.statuses[id]).toMatchObject({
      claudeSessionId: "thread-abc",
      agentType: "codex",
    });
    expect(resolveCodexThreadIdForSession).toHaveBeenCalledWith(row, activity);
    expect(markCodexThreadVerified).toHaveBeenCalledWith(
      id,
      "thread-abc",
      activity
    );
    expect(state.updateRuns).toContainEqual(["thread-abc", id, "thread-abc"]);
  });

  it("clears a stale Codex thread id when live activity cannot verify it", async () => {
    const id = "cccccccc-1111-2222-3333-444444444444";
    const name = `codex-${id}`;
    const row = {
      id,
      name: "Codex",
      tmux_name: name,
      created_at: "2026-07-07 10:00:00",
      updated_at: "2026-07-07 10:00:00",
      status: "idle",
      working_directory: "C:\\repo",
      parent_session_id: null,
      claude_session_id: "old-thread",
      model: "gpt-5.5",
      system_prompt: null,
      group_path: "",
      project_id: null,
      agent_type: "codex",
      auto_approve: false,
      worktree_path: null,
      branch_name: null,
      base_branch: null,
      dev_server_port: null,
      pr_url: null,
      pr_number: null,
      pr_status: null,
      conductor_session_id: null,
      worker_task: null,
      worker_status: null,
      mcp_launch_args: null,
    } as Session;
    state.sessions = [{ name, activity: 1_783_410_042 }];
    state.dbSessions.set(id, row);
    state.codexThreadId = null;

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await getBody(res);
    expect(body.statuses[id]).toMatchObject({
      claudeSessionId: null,
      agentType: "codex",
    });
    expect(clearCodexThreadVerification).toHaveBeenCalledWith(id);
    expect(state.updateRuns).toContainEqual([id]);
  });
});
