import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PromptState } from "@/lib/auto-steer";

// The backend the route drives. capture feeds the approve re-verify; sendEnter/kill are
// the ops. Keep notification-actions (isRespondAction/applyResponse/canApproveFromPrompt)
// REAL — only the live-prompt detection is mocked, so we can drive the TOCTOU re-check.
const backend = vi.hoisted(() => ({
  exists: vi.fn(async () => true),
  capture: vi.fn(async () => ""),
  sendEnter: vi.fn(async () => {}),
  kill: vi.fn(async () => {}),
}));
const live = vi.hoisted(() => ({ prompt: null as PromptState | null }));

vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  queries: {
    getSession: () => ({
      get: (id: string) => ({
        id,
        name: id,
        tmux_name: id,
        agent_type: "claude",
      }),
    }),
  },
}));
vi.mock("@/lib/session-backend", () => ({ getSessionBackend: () => backend }));
vi.mock("@/lib/auto-steer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auto-steer")>();
  return { ...actual, detectPrompt: vi.fn(() => live.prompt) };
});

import { POST } from "@/app/api/sessions/[id]/respond/route";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const req = (action: unknown): any => ({ json: async () => ({ action }) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const ORIGINAL_PUSH_APPROVE = process.env.STOA_PUSH_APPROVE;

beforeEach(() => {
  backend.exists.mockReset().mockResolvedValue(true);
  backend.capture.mockReset().mockResolvedValue("screen");
  backend.sendEnter.mockReset().mockResolvedValue(undefined);
  backend.kill.mockReset().mockResolvedValue(undefined);
  live.prompt = null;
  // The route enforces the STOA_PUSH_APPROVE opt-in; default it ON so the approve-path tests
  // exercise the real flow. The "off → 409" test below clears it explicitly.
  process.env.STOA_PUSH_APPROVE = "1";
});

afterEach(() => {
  if (ORIGINAL_PUSH_APPROVE === undefined) delete process.env.STOA_PUSH_APPROVE;
  else process.env.STOA_PUSH_APPROVE = ORIGINAL_PUSH_APPROVE;
});

describe("POST /api/sessions/[id]/respond", () => {
  it("stop → kill (no prompt re-verify / capture)", async () => {
    const res = await POST(req("stop"), ctx("s1"));
    expect(res.status).toBe(200);
    expect(backend.kill).toHaveBeenCalledWith("s1");
    expect(backend.capture).not.toHaveBeenCalled();
  });

  it("approve 409s WITHOUT capture/Enter when STOA_PUSH_APPROVE is off (opt-in gate)", async () => {
    delete process.env.STOA_PUSH_APPROVE; // user did not opt into one-tap Approve
    live.prompt = { kind: "continue", line: "[Y/n]" }; // would otherwise be approvable
    const res = await POST(req("approve"), ctx("s1"));
    expect(res.status).toBe(409);
    expect(backend.capture).not.toHaveBeenCalled(); // gate is checked before the re-verify
    expect(backend.sendEnter).not.toHaveBeenCalled();
  });

  it("approve presses Enter when the LIVE prompt is still a safe press-Enter-to-continue", async () => {
    live.prompt = { kind: "continue", line: "Press Enter to continue" };
    const res = await POST(req("approve"), ctx("s1"));
    expect(res.status).toBe(200);
    expect(backend.capture).toHaveBeenCalledWith("s1"); // re-verified
    expect(backend.sendEnter).toHaveBeenCalledWith("s1");
  });

  it("approve 409s WITHOUT Enter for a permission MENU's single-shot Yes (affirmative is a BLIND command grant — not one-tap approvable)", async () => {
    live.prompt = { kind: "affirmative", line: "❯ 1. Yes" };
    const res = await POST(req("approve"), ctx("s1"));
    expect(res.status).toBe(409);
    expect(backend.sendEnter).not.toHaveBeenCalled();
  });

  it("approve 409s WITHOUT Enter when the prompt vanished (TOCTOU)", async () => {
    live.prompt = null; // prompt cleared between push and tap
    const res = await POST(req("approve"), ctx("s1"));
    expect(res.status).toBe(409);
    expect(backend.sendEnter).not.toHaveBeenCalled();
  });

  it("approve 409s WITHOUT Enter when the prompt turned risky (a destructive confirm)", async () => {
    live.prompt = { kind: "destructive", line: "❯ 1. Yes, delete everything" };
    const res = await POST(req("approve"), ctx("s1"));
    expect(res.status).toBe(409);
    expect(backend.sendEnter).not.toHaveBeenCalled();
  });

  it("409s when the session isn't running; 400 for an unknown action", async () => {
    backend.exists.mockResolvedValue(false);
    expect((await POST(req("approve"), ctx("s1"))).status).toBe(409);
    backend.exists.mockResolvedValue(true);
    expect((await POST(req("nope"), ctx("s1"))).status).toBe(400);
  });

  it("serializes concurrent approves — a double-tap 409s, only ONE Enter fires", async () => {
    live.prompt = { kind: "continue", line: "[Y/n]" };
    // Park the first approve on a sendEnter we hold open, so the second arrives mid-flight.
    let release: () => void = () => {};
    backend.sendEnter
      .mockReset()
      .mockImplementation(() => new Promise<void>((r) => (release = r)));
    const first = POST(req("approve"), ctx("s1"));
    // Flush microtasks so `first` runs through exists/capture/verify and parks on sendEnter,
    // holding the in-flight guard.
    await new Promise((r) => setTimeout(r, 0));
    const second = await POST(req("approve"), ctx("s1"));
    expect(second.status).toBe(409); // guard rejected the double-tap
    release();
    expect((await first).status).toBe(200);
    expect(backend.sendEnter).toHaveBeenCalledTimes(1); // only one Enter ever fired
  });
});
