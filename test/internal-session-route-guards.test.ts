import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  session: {
    id: "internal-supervisor",
    name: "Fleet managed supervisor",
    tmux_name: "claude-internal-supervisor",
    working_directory: "C:\\temp",
    agent_type: "claude",
    model: "sonnet",
    system_prompt: null,
    group_path: "__fleet_internal__",
    project_id: null,
    auto_approve: false,
    session_role: "fleet_supervisor",
    claude_session_id: null,
  },
  createSession: vi.fn(),
  capture: vi.fn(async () => ""),
  exists: vi.fn(async () => true),
  pasteText: vi.fn(async () => undefined),
  kill: vi.fn(async () => undefined),
  enqueue: vi.fn(),
  prepareSnapshotFork: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const fakeDb = {};
  return {
    db: fakeDb,
    getDb: () => fakeDb,
    queries: {
      getSession: () => ({
        get: (id: string) =>
          id === state.session.id ? state.session : undefined,
      }),
      createSession: () => ({ run: state.createSession }),
      getSessionMessages: () => ({ all: () => [] }),
      createMessage: () => ({ run: vi.fn() }),
      updateSessionForkBaseline: () => ({ run: vi.fn() }),
    },
  };
});

vi.mock("@/lib/session-backend", () => ({
  getSessionBackend: () => ({
    capture: state.capture,
    exists: state.exists,
    pasteText: state.pasteText,
    kill: state.kill,
  }),
}));

vi.mock("@/lib/prompt-queue", () => ({
  enqueuePrompt: state.enqueue,
  enqueuePromptIdempotent: state.enqueue,
  listQueue: vi.fn(() => []),
  clearQueue: vi.fn(),
  removeAt: vi.fn(() => []),
  moveUp: vi.fn(() => []),
  moveDown: vi.fn(() => []),
}));

vi.mock("@/lib/session-cost", () => ({
  readClaudeSessionUsage: vi.fn(async () => null),
}));

vi.mock("@/lib/checkpoints", () => ({
  prepareForkFromSnapshot: state.prepareSnapshotFork,
  createCheckpoint: vi.fn(),
  buildForkFeatureName: vi.fn(() => "internal-fork"),
}));

vi.mock("@/lib/worktrees", () => ({
  deleteWorktree: vi.fn(async () => undefined),
}));

import { POST as forkSession } from "@/app/api/sessions/[id]/fork/route";
import { POST as forkSnapshot } from "@/app/api/sessions/[id]/snapshots/[seq]/fork/route";
import { POST as sendKeys } from "@/app/api/sessions/[id]/send-keys/route";
import { POST as respond } from "@/app/api/sessions/[id]/respond/route";
import { POST as repairMcp } from "@/app/api/sessions/[id]/mcp-config/route";
import { POST as queuePrompt } from "@/app/api/sessions/[id]/queue/route";
import { GET as preview } from "@/app/api/sessions/[id]/preview/route";
import { genericSessionRouteFailure } from "@/lib/session-route-access";

function request(body: Record<string, unknown>, method = "POST"): Request {
  return new Request("http://localhost/api/sessions/internal-supervisor", {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
}

const context = {
  params: Promise.resolve({ id: "internal-supervisor" }),
};

describe("internal session generic-route isolation", () => {
  beforeEach(() => {
    state.createSession.mockReset();
    state.capture.mockClear();
    state.exists.mockClear();
    state.pasteText.mockClear();
    state.kill.mockClear();
    state.enqueue.mockReset();
    state.prepareSnapshotFork.mockReset();
  });

  it("fails closed for unknown roles while preserving ordinary interactive rows", () => {
    expect(
      genericSessionRouteFailure({
        ...state.session,
        session_role: "future_internal_role",
      } as never)
    ).toEqual({
      error: "Internal sessions are managed only by their owning subsystem",
      status: 409,
    });
    expect(
      genericSessionRouteFailure({
        ...state.session,
        session_role: "interactive",
      } as never)
    ).toBeNull();
  });

  it("rejects plain and snapshot forks before allocating a session or worktree", async () => {
    const plain = await forkSession(
      request({ name: "forbidden fork" }) as never,
      context
    );
    const snapshot = await forkSnapshot(
      request({ name: "forbidden snapshot fork" }) as never,
      { params: Promise.resolve({ id: "internal-supervisor", seq: "1" }) }
    );
    expect(plain.status).toBe(409);
    expect(snapshot.status).toBe(409);
    expect(state.createSession).not.toHaveBeenCalled();
    expect(state.prepareSnapshotFork).not.toHaveBeenCalled();
    expect(state.capture).not.toHaveBeenCalled();
  });

  it("rejects generic input, orchestration repair, queueing, and preview before backend side effects", async () => {
    const responses = await Promise.all([
      sendKeys(
        request({ text: "hostile", pressEnter: true }) as never,
        context
      ),
      respond(request({ action: "stop" }) as never, context),
      repairMcp(request({}) as never, context),
      queuePrompt(request({ text: "hostile queue" }) as never, context),
      preview(request({}, "GET") as never, context),
    ]);
    expect(responses.map((response) => response.status)).toEqual([
      409, 409, 409, 409, 409,
    ]);
    expect(state.exists).not.toHaveBeenCalled();
    expect(state.capture).not.toHaveBeenCalled();
    expect(state.pasteText).not.toHaveBeenCalled();
    expect(state.kill).not.toHaveBeenCalled();
    expect(state.enqueue).not.toHaveBeenCalled();
  });

  it("keeps every generic mutation boundary and live status/attach path on the shared guard", () => {
    const guardedRoutes = [
      "app/api/sessions/[id]/route.ts",
      "app/api/sessions/[id]/launch/route.ts",
      "app/api/sessions/[id]/send-keys/route.ts",
      "app/api/sessions/[id]/respond/route.ts",
      "app/api/sessions/[id]/mcp-config/route.ts",
      "app/api/sessions/[id]/queue/route.ts",
      "app/api/sessions/[id]/messages/route.ts",
      "app/api/sessions/[id]/checkpoints/route.ts",
      "app/api/sessions/[id]/snapshots/[seq]/restore/route.ts",
      "app/api/sessions/[id]/ceremony/route.ts",
      "app/api/sessions/[id]/pr/route.ts",
      "app/api/sessions/[id]/fork/route.ts",
      "app/api/sessions/[id]/snapshots/[seq]/fork/route.ts",
    ];
    for (const route of guardedRoutes) {
      expect(readFileSync(resolve(route), "utf8"), route).toContain(
        "genericSessionRouteFailure"
      );
    }
    expect(
      readFileSync(resolve("app/api/sessions/status/route.ts"), "utf8")
    ).toContain("isGenericSessionLaunchAllowed");
    expect(readFileSync(resolve("server.ts"), "utf8")).toContain(
      "genericBackendKeyAccessFailure"
    );
  });
});
