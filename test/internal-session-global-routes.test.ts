import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { join } from "path";
import { homeDir } from "@/lib/platform";

const state = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  deleted: [] as string[],
  backendNames: [] as string[],
  list: vi.fn<() => Promise<string[]>>(),
  kill: vi.fn(),
  transcript: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  queries: {
    getAllSessions: () => ({ all: () => state.sessions }),
    deleteSession: () => ({
      run: (id: string) => {
        state.deleted.push(id);
        return { changes: 1 };
      },
    }),
    getAllProjects: () => ({ all: () => [] }),
    getAllProjectRepositories: () => ({ all: () => [] }),
    getAllDispatchRepos: () => ({ all: () => [] }),
  },
}));

vi.mock("@/lib/session-backend", () => ({
  getSessionBackend: () => ({ list: state.list, kill: state.kill }),
}));

vi.mock("@/lib/claude-transcript", () => ({
  readClaudeTranscriptRaw: state.transcript,
}));

import { POST as killAll } from "@/app/api/tmux/kill-all/route";
import { GET as searchOutput } from "@/app/api/output-search/route";
import { getAllowedPathRoots } from "@/lib/api-security";

const VISIBLE_ID = "11111111-1111-4111-8111-111111111111";
const INTERNAL_ID = "22222222-2222-4222-8222-222222222222";
const VISIBLE_KEY = `claude-${VISIBLE_ID}`;
const INTERNAL_KEY = `claude-${INTERNAL_ID}`;

function searchRequest(query: string): NextRequest {
  const controller = new AbortController();
  return {
    nextUrl: new URL(`http://localhost/api/output-search?q=${query}`),
    signal: controller.signal,
  } as unknown as NextRequest;
}

describe("internal sessions on global generic surfaces", () => {
  beforeEach(() => {
    state.deleted = [];
    state.sessions = [
      {
        id: VISIBLE_ID,
        name: "Visible",
        tmux_name: VISIBLE_KEY,
        agent_type: "claude",
        working_directory: "C:/repos/visible",
        worktree_path: "C:/worktrees/visible",
        claude_session_id: "visible-native",
        session_role: "interactive",
      },
      {
        id: INTERNAL_ID,
        name: "Managed supervisor",
        tmux_name: INTERNAL_KEY,
        agent_type: "claude",
        working_directory: "C:/private/internal",
        worktree_path: "C:/private/internal-worktree",
        claude_session_id: "internal-native",
        session_role: "future_internal_role",
      },
    ];
    state.list.mockReset().mockResolvedValue([VISIBLE_KEY, INTERNAL_KEY]);
    state.kill.mockReset().mockResolvedValue(undefined);
    state.transcript.mockReset().mockResolvedValue(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "needle found" }] },
      })
    );
  });

  it("kill-all neither terminates nor deletes a server-owned session", async () => {
    const response = await killAll(
      new Request("http://localhost/api/tmux/kill-all", {
        method: "POST",
        headers: { host: "localhost" },
      }) as unknown as NextRequest
    );

    expect(response.status).toBe(200);
    expect(state.kill).toHaveBeenCalledTimes(1);
    expect(state.kill).toHaveBeenCalledWith(VISIBLE_KEY);
    expect(state.deleted).toEqual([VISIBLE_ID]);
    expect(await response.json()).toMatchObject({
      killed: 1,
      sessions: [VISIBLE_KEY],
      deletedFromDb: 1,
    });
  });

  it("output search never opens an internal transcript", async () => {
    const response = await searchOutput(searchRequest("needle"));
    const body = await response.json();

    expect(body.results.map((result: { id: string }) => result.id)).toEqual([
      VISIBLE_ID,
    ]);
    expect(state.transcript).toHaveBeenCalledTimes(1);
    expect(state.transcript).toHaveBeenCalledWith(
      "C:/repos/visible",
      "visible-native"
    );
  });

  it("never turns an internal cwd or worktree into a generic sandbox root", () => {
    const roots = getAllowedPathRoots().map((root) =>
      root.replaceAll("\\", "/").toLowerCase()
    );

    expect(roots).toContain("c:/repos/visible");
    expect(roots).toContain("c:/worktrees/visible");
    expect(roots).not.toContain("c:/private/internal");
    expect(roots).not.toContain("c:/private/internal-worktree");
    expect(roots).not.toContain(
      join(homeDir(), ".stoa").replaceAll("\\", "/").toLowerCase()
    );
  });
});
