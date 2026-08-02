import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface BackendCreateCall {
  name: string;
  cwd: string;
  command: string;
  binary?: string;
  args?: string[];
  env?: Record<string, string>;
}

const state = vi.hoisted(() => ({
  backendType: "tmux" as "tmux" | "pty",
  session: {} as Record<string, unknown>,
  sessions: [] as Record<string, unknown>[],
  exists: vi.fn(async () => false),
  create: vi.fn(async (_options: BackendCreateCall) => undefined),
  kill: vi.fn(async (_key: string) => undefined),
  deletionFenced: vi.fn((_sessionId: string) => false),
  backendKeyFenced: vi.fn((_backendKey: string) => false),
  wrapWithBanner: vi.fn((command: string) => `banner:${command}`),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  queries: {
    getSession: () => ({
      get: (id: string) =>
        state.session.id === id ? state.session : undefined,
    }),
    getAllSessions: () => ({ all: () => state.sessions }),
  },
}));

vi.mock("@/lib/session-backend", () => ({
  getBackendType: () => state.backendType,
  getSessionBackend: () => ({
    exists: state.exists,
    create: state.create,
    kill: state.kill,
  }),
}));

vi.mock("@/lib/session-deletion", () => ({
  isSessionDeletionBoundaryFenced: (
    _db: unknown,
    sessionId: string,
    backendKeys: readonly string[]
  ) =>
    state.deletionFenced(sessionId) ||
    backendKeys.some((backendKey) => state.backendKeyFenced(backendKey)),
}));

vi.mock("@/lib/banner", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/banner")>();
  return {
    ...original,
    wrapWithBanner: state.wrapWithBanner,
  };
});

import { POST } from "@/app/api/sessions/[id]/launch/route";

const ID = "12345678-1234-4234-8234-123456789abc";

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    name: "Interactive",
    tmux_name: null,
    working_directory: "/repo",
    agent_type: "claude",
    model: "sonnet",
    auto_approve: false,
    approval_mode: "prompt",
    claude_session_id: null,
    parent_session_id: null,
    mcp_launch_args: null,
    session_role: "interactive",
    ...overrides,
  };
}

function request(initialPrompt?: unknown): Request {
  return new Request(`http://localhost/api/sessions/${ID}/launch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initialPrompt }),
  });
}

const context = { params: Promise.resolve({ id: ID }) };

describe("server-owned interactive tmux launch", () => {
  beforeEach(() => {
    state.backendType = "tmux";
    state.session = session();
    state.sessions = [state.session];
    state.exists.mockReset().mockResolvedValue(false);
    state.create.mockReset().mockResolvedValue(undefined);
    state.kill.mockReset().mockResolvedValue(undefined);
    state.deletionFenced.mockReset().mockReturnValue(false);
    state.backendKeyFenced.mockReset().mockReturnValue(false);
    state.wrapWithBanner.mockClear();
  });

  it("passes initial prompt and conductor identity through SessionBackend.create", async () => {
    state.session = session({
      agent_type: "codex",
      model: "gpt-5.5",
      mcp_launch_args: JSON.stringify(["-c", "mcp_servers.stoa.command=node"]),
    });
    state.sessions = [state.session];

    const response = await POST(request("do the thing") as never, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      created: true,
      sessionName: `codex-${ID}`,
    });
    expect(state.wrapWithBanner).toHaveBeenCalledTimes(1);
    const command = state.wrapWithBanner.mock.calls[0][0];
    expect(command).toContain("codex");
    expect(command).toContain("mcp_servers.stoa.command=node");
    expect(command).toContain("do the thing");
    expect(state.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: `codex-${ID}`,
        cwd: "/repo",
        command: `banner:${command}`,
        binary: "codex",
        env: { STOA_CONDUCTOR_SESSION_ID: ID },
      })
    );
    const launch = state.create.mock.calls[0][0];
    expect(launch.args).toContain("do the thing");
    expect(launch.args).toContain("mcp_servers.stoa.command=node");
  });

  it("reattaches without recreating or replaying an initial prompt", async () => {
    state.exists.mockResolvedValue(true);

    const response = await POST(request("must not replay") as never, context);

    expect(await response.json()).toEqual({
      success: true,
      created: false,
      sessionName: `claude-${ID}`,
    });
    expect(state.create).not.toHaveBeenCalled();
    expect(state.wrapWithBanner).not.toHaveBeenCalled();
  });

  it("resolves an unstarted native fork from its interactive parent", async () => {
    const parentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const parent = session({
      id: parentId,
      tmux_name: `claude-${parentId}`,
      claude_session_id: "provider-parent-id",
    });
    state.session = session({ parent_session_id: parentId });
    state.sessions = [parent, state.session];

    const response = await POST(request() as never, context);

    expect(response.status).toBe(200);
    const command = state.wrapWithBanner.mock.calls[0][0];
    expect(command).toContain("--resume");
    expect(command).toContain("provider-parent-id");
    expect(command).toContain("--fork-session");
    const launch = state.create.mock.calls[0][0];
    expect(launch.args).toEqual(
      expect.arrayContaining([
        "--resume",
        "provider-parent-id",
        "--fork-session",
      ])
    );
  });

  it("creates shell sessions without an agent command or environment overlay", async () => {
    state.session = session({ agent_type: "shell" });
    state.sessions = [state.session];

    const response = await POST(request() as never, context);

    expect(response.status).toBe(200);
    expect(state.create).toHaveBeenCalledWith({
      name: `shell-${ID}`,
      cwd: "/repo",
      command: "",
      binary: undefined,
      args: undefined,
      env: {},
    });
    expect(state.wrapWithBanner).not.toHaveBeenCalled();
  });

  it("rejects pty and internal-session launches before backend side effects", async () => {
    state.backendType = "pty";
    const ptyResponse = await POST(request() as never, context);
    expect(ptyResponse.status).toBe(409);

    state.backendType = "tmux";
    state.session = session({ session_role: "fleet_worker" });
    state.sessions = [state.session];
    const internalResponse = await POST(request() as never, context);
    expect(internalResponse.status).toBe(409);
    expect(state.exists).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });

  it("rejects oversized prompts before backend side effects", async () => {
    const response = await POST(request("x".repeat(200_001)) as never, context);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "initialPrompt exceeds maximum length",
    });
    expect(state.exists).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });

  it("rejects a launch whose session identity is already deletion-fenced", async () => {
    state.deletionFenced.mockReturnValue(true);

    const response = await POST(request() as never, context);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Session deletion is in progress",
    });
    expect(state.exists).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });

  it("rejects a launch whose backend key is a completed tombstone", async () => {
    state.backendKeyFenced.mockImplementation(
      (backendKey) => backendKey === `claude-${ID}`
    );

    const response = await POST(request() as never, context);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Session deletion is in progress",
    });
    expect(state.exists).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });

  it("rechecks the backend tombstone after exists and before create", async () => {
    state.exists.mockImplementationOnce(async () => {
      state.backendKeyFenced.mockReturnValue(true);
      return false;
    });

    const response = await POST(request() as never, context);

    expect(response.status).toBe(409);
    expect(state.create).not.toHaveBeenCalled();
  });

  it("kills a process created while deletion publishes its fence", async () => {
    state.create.mockImplementationOnce(async () => {
      state.backendKeyFenced.mockReturnValue(true);
    });

    const response = await POST(request() as never, context);

    expect(response.status).toBe(409);
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.kill).toHaveBeenCalledWith(`claude-${ID}`);
    expect(await response.json()).toEqual({
      error: "Session deletion is in progress",
    });
  });
});

describe("browser tmux launch boundary", () => {
  it("keeps creation server-side and leaves app/page.tsx attach-only", () => {
    const page = readFileSync(resolve("app/page.tsx"), "utf8");
    const route = readFileSync(
      resolve("app/api/sessions/[id]/launch/route.ts"),
      "utf8"
    );

    expect(page).toContain("launchTmuxSession(");
    expect(page).toContain("tmux attach -t");
    expect(page).not.toMatch(/tmux new(?:-session)?\b/);
    expect(route).toContain("getSessionBackend()");
    expect(route).toContain("await backend.create({");
  });
});
