import { describe, it, expect, beforeEach, vi } from "vitest";

const state = {
  sessions: [] as string[],
  kimiIds: new Map<string, string>(),
  statusDetailCalls: 0,
  getKimiSessionIdCalls: 0,
};

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    // run for the status/claude-id updates; get for the #19 verify-badge read
    // (undefined = no verdict — the route null-coalesces it).
    prepare: () => ({ run: () => {}, get: () => undefined }),
  }),
  queries: {},
}));

vi.mock("@/lib/session-backend", () => ({
  getSessionBackend: () => ({
    list: async () => state.sessions,
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

import { GET } from "@/app/api/sessions/status/route";

async function getBody(res: Response) {
  return (await res.json()) as { statuses: Record<string, unknown> };
}

describe("/api/sessions/status — Kimi branch", () => {
  beforeEach(() => {
    state.sessions = [];
    state.kimiIds.clear();
    state.statusDetailCalls = 0;
    state.getKimiSessionIdCalls = 0;
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
});
