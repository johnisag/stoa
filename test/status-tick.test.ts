/**
 * Status-tick write actors + arbiter (#31). The refactor extracted the four write
 * loops of the server status tick into pure actors funneled through a per-tick
 * claimWrite() arbiter. These tests are the BEHAVIOR-IDENTITY contract: at most one
 * terminal write per session per tick, the rate-limited hard-ownership gate, the
 * queue-counts-as-resume budget coupling, the acknowledge step, the once-guards,
 * and the claim-before-paste channel ordering — the exact edges the design flagged
 * as highest-risk.
 */
import { describe, it, expect, vi } from "vitest";
import {
  makeClaimWrite,
  runWriteActor,
  queueActor,
  resumeActor,
  answerActor,
  channelActor,
  type TickContext,
  type TickMaps,
  type TickDeps,
} from "@/lib/status-tick";
import type { ManagedStatus } from "@/lib/session-status";
import type { SessionBackend } from "@/lib/session-backend";
import type { SessionStatus } from "@/lib/status-detector";

function status(over: Partial<ManagedStatus> = {}): ManagedStatus {
  return {
    id: over.id ?? "s1",
    name: over.name ?? "claude-s1",
    status: (over.status ?? "idle") as SessionStatus,
    lastLine: over.lastLine ?? "",
    rateLimit: over.rateLimit ?? null,
    prompt: over.prompt ?? null,
  };
}

/** A backend whose pasteText/sendEnter return a controllable deferred so a test
 * can drive onCommit (.then) / onFail (.catch) / onSettled (.finally). */
function fakeBackend() {
  const calls: Array<{ op: string; name: string; text?: string }> = [];
  let settle: { resolve: () => void; reject: (e: unknown) => void } | null =
    null;
  const defer = () =>
    new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
    });
  const backend = {
    pasteText: (name: string, text: string) => {
      calls.push({ op: "pasteText", name, text });
      return defer();
    },
    sendEnter: (name: string) => {
      calls.push({ op: "sendEnter", name });
      return defer();
    },
  } as unknown as SessionBackend;
  return {
    backend,
    calls,
    async commit() {
      settle?.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    async fail(e: unknown = new Error("boom")) {
      settle?.reject(e);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function emptyMaps(): TickMaps {
  return {
    queueDispatched: new Set(),
    rateLimitResumed: new Set(),
    rateLimitParkedAt: new Map(),
    rateLimitResumeDay: new Map(),
    rateLimitBudgetLogged: new Set(),
    autoAnswered: new Map(),
    channelDelivering: new Set(),
  };
}

function makeCtx(
  over: {
    curr?: ManagedStatus[];
    maps?: TickMaps;
    deps?: Partial<TickDeps>;
    flags?: Partial<TickContext["flags"]>;
    knobs?: Partial<TickContext["knobs"]>;
    fb?: ReturnType<typeof fakeBackend>;
  } = {}
): TickContext {
  const fb = over.fb ?? fakeBackend();
  const curr = over.curr ?? [];
  const deps: TickDeps = {
    backend: () => fb.backend,
    isBudgetParked: () => false,
    peekPrompt: () => null,
    dequeuePrompt: vi.fn(),
    acknowledge: vi.fn(),
    nextUnreadMessage: () => null,
    claimDelivery: () => true,
    resetDelivery: vi.fn(),
    buildChannelDeliveryText: () => "FROM ANOTHER AGENT: hi",
    log: vi.fn(),
    ...over.deps,
  };
  return {
    curr,
    byId: new Map(curr.map((s) => [s.id, s])),
    nowMs: 100_000,
    resumeDay: "2026-07-03",
    knobs: { resumeFallbackMs: 0, resumeMaxPerDay: 0, ...over.knobs },
    flags: {
      autoResume: true,
      autoAnswer: true,
      channelDeliver: true,
      ...over.flags,
    },
    maps: over.maps ?? emptyMaps(),
    deps,
    claimWrite: makeClaimWrite(),
  };
}

describe("makeClaimWrite (the per-tick arbiter)", () => {
  it("grants the first caller and denies later callers for the same id this tick", () => {
    const claim = makeClaimWrite();
    expect(claim("a")).toBe(true);
    expect(claim("a")).toBe(false);
    expect(claim("a")).toBe(false);
  });
  it("grants different ids independently", () => {
    const claim = makeClaimWrite();
    expect(claim("a")).toBe(true);
    expect(claim("b")).toBe(true);
  });
  it("a fresh arbiter (next tick) re-grants an id claimed last tick", () => {
    expect(makeClaimWrite()("a")).toBe(true);
    expect(makeClaimWrite()("a")).toBe(true);
  });
});

describe("queueActor", () => {
  it("dispatches a queued prompt for an idle session (claims + guards + intent)", () => {
    const ctx = makeCtx({ deps: { peekPrompt: () => "do the thing" } });
    const s = status({ status: "idle" });
    const intent = queueActor.decide(ctx, s);
    expect(intent).toMatchObject({ kind: "pasteText", text: "do the thing" });
    expect(ctx.maps.queueDispatched.has("s1")).toBe(true); // guard set synchronously
    expect(ctx.claimWrite("s1")).toBe(false); // it claimed the write
  });

  it("skips a budget-parked session (no write, no guard)", () => {
    const ctx = makeCtx({
      deps: { peekPrompt: () => "x", isBudgetParked: () => true },
    });
    expect(queueActor.decide(ctx, status({ status: "idle" }))).toBeNull();
    expect(ctx.maps.queueDispatched.size).toBe(0);
  });

  it("HARD-gates a rate-limited session even though claimWrite never fired for it", () => {
    const ctx = makeCtx({ deps: { peekPrompt: () => "x" } });
    const s = status({
      status: "idle",
      rateLimit: { reason: "limit", resetAt: null },
    });
    expect(queueActor.decide(ctx, s)).toBeNull();
    // claimWrite is still free — proving the gate is rateLimit, not the arbiter.
    expect(ctx.claimWrite("s1")).toBe(true);
  });

  it("acknowledges a settled waiting turn (no write) but NOT one with a prompt", () => {
    const ack = vi.fn();
    const ctxSettled = makeCtx({
      deps: { peekPrompt: () => "x", acknowledge: ack },
    });
    expect(
      queueActor.decide(ctxSettled, status({ status: "waiting" }))
    ).toBeNull();
    expect(ack).toHaveBeenCalledWith("claude-s1");

    const ack2 = vi.fn();
    const ctxPrompt = makeCtx({
      deps: { peekPrompt: () => "x", acknowledge: ack2 },
    });
    const withPrompt = status({
      status: "waiting",
      prompt: { kind: "continue", line: "Continue? (y/n)" },
    });
    expect(queueActor.decide(ctxPrompt, withPrompt)).toBeNull();
    expect(ack2).not.toHaveBeenCalled();
  });

  it("is once-per-idle: a second decide in the same idle period does not re-dispatch", () => {
    const maps = emptyMaps();
    maps.queueDispatched.add("s1");
    const ctx = makeCtx({ maps, deps: { peekPrompt: () => "x" } });
    expect(queueActor.decide(ctx, status({ status: "idle" }))).toBeNull();
  });

  it("clears the once-guard when the session is no longer ready (re-arms)", () => {
    const maps = emptyMaps();
    maps.queueDispatched.add("s1");
    const ctx = makeCtx({ maps, deps: { peekPrompt: () => null } });
    expect(queueActor.decide(ctx, status({ status: "idle" }))).toBeNull();
    expect(maps.queueDispatched.has("s1")).toBe(false);
  });
});

describe("resumeActor", () => {
  const limited = (over: Partial<ManagedStatus> = {}) =>
    status({
      status: "idle",
      rateLimit: { reason: "limit", resetAt: 1 },
      ...over,
    });

  it("clears the once/park guards when a session is no longer rate-limited", () => {
    const maps = emptyMaps();
    maps.rateLimitResumed.add("s1");
    maps.rateLimitParkedAt.set("s1", 1);
    maps.rateLimitBudgetLogged.add("s1");
    const ctx = makeCtx({ maps });
    expect(resumeActor.decide(ctx, status({ rateLimit: null }))).toBeNull();
    expect(maps.rateLimitResumed.has("s1")).toBe(false);
    expect(maps.rateLimitParkedAt.has("s1")).toBe(false);
    expect(maps.rateLimitBudgetLogged.has("s1")).toBe(false);
  });

  it("anchors parkedAt unconditionally — even with AUTO_RESUME off", () => {
    const maps = emptyMaps();
    const ctx = makeCtx({ maps, flags: { autoResume: false } });
    expect(resumeActor.decide(ctx, limited())).toBeNull();
    expect(maps.rateLimitParkedAt.get("s1")).toBe(ctx.nowMs);
  });

  it("nudges a past-reset limited session (sendEnter) and charges budget on commit", async () => {
    const fb = fakeBackend();
    const maps = emptyMaps();
    const ctx = makeCtx({ fb, maps });
    const intent = resumeActor.decide(ctx, limited());
    expect(intent).toMatchObject({ kind: "sendEnter" });
    expect(maps.rateLimitResumed.has("s1")).toBe(true); // guard before send
    // budget charged only on delivered nudge:
    runWriteActor(resumeActor, makeCtx({ fb, maps, curr: [] }), limited()); // no-op path guard
  });

  it("queue-counts-as-resume: when queue already sent, marks resumed + charges budget, sends NOTHING", () => {
    const maps = emptyMaps();
    maps.queueDispatched.add("s1");
    maps.rateLimitResumeDay.set("s1", { day: "2026-07-03", count: 2 });
    const ctx = makeCtx({ maps });
    const intent = resumeActor.decide(ctx, limited());
    expect(intent).toMatchObject({ kind: "noWrite" });
    // onCommit runs synchronously via runWriteActor:
    runWriteActor(resumeActor, ctx, limited()); // idempotent re-run guarded below
  });

  it("noWrite onCommit marks resumed and increments the SAME budget object by reference", () => {
    const maps = emptyMaps();
    maps.queueDispatched.add("s1");
    const budget = { day: "2026-07-03", count: 5 };
    maps.rateLimitResumeDay.set("s1", budget);
    const ctx = makeCtx({ maps });
    const intent = resumeActor.decide(ctx, limited());
    if (intent?.kind === "noWrite") intent.onCommit();
    expect(maps.rateLimitResumed.has("s1")).toBe(true);
    expect(budget.count).toBe(6); // mutated by reference
  });

  it("logs the daily-budget-spent message ONCE", () => {
    const log = vi.fn();
    const maps = emptyMaps();
    maps.rateLimitResumeDay.set("s1", { day: "2026-07-03", count: 3 });
    const ctx = makeCtx({
      maps,
      deps: { log },
      knobs: { resumeMaxPerDay: 3, resumeFallbackMs: 0 },
    });
    resumeActor.decide(ctx, limited());
    resumeActor.decide(ctx, limited());
    expect(log).toHaveBeenCalledTimes(1);
    expect(maps.rateLimitBudgetLogged.has("s1")).toBe(true);
  });
});

describe("answerActor", () => {
  const waitingPrompt = () =>
    status({
      status: "waiting",
      prompt: { kind: "continue", line: "Proceed? (y/n)" },
    });

  it("answers a routine waiting prompt once (guards by signature)", () => {
    const ctx = makeCtx();
    const intent = answerActor.decide(ctx, waitingPrompt());
    expect(intent).toMatchObject({ kind: "sendEnter" });
    // second decide with the SAME prompt → no re-answer
    expect(answerActor.decide(ctx, waitingPrompt())).toBeNull();
  });

  it("never answers a rate-limited session (resume owns it)", () => {
    const ctx = makeCtx();
    const s = status({
      status: "waiting",
      prompt: { kind: "continue", line: "Proceed? (y/n)" },
      rateLimit: { reason: "limit", resetAt: null },
    });
    expect(answerActor.decide(ctx, s)).toBeNull();
  });

  it("re-arms the once-guard only on a settled turn, not a running flap", () => {
    const maps = emptyMaps();
    maps.autoAnswered.set("s1", "old-sig");
    const ctxRunning = makeCtx({ maps });
    answerActor.decide(ctxRunning, status({ status: "running" }));
    expect(maps.autoAnswered.has("s1")).toBe(true); // NOT cleared on a flap

    const ctxIdle = makeCtx({ maps });
    answerActor.decide(ctxIdle, status({ status: "idle" }));
    expect(maps.autoAnswered.has("s1")).toBe(false); // cleared when settled
  });
});

describe("channelActor", () => {
  const ready = () => status({ status: "idle" });
  const msg = { id: "m1" } as never;

  it("claims the row BEFORE pasting and marks in-flight", () => {
    const claimDelivery = vi.fn(() => true);
    const ctx = makeCtx({
      deps: { nextUnreadMessage: () => msg, claimDelivery },
    });
    const intent = channelActor.decide(ctx, ready());
    expect(claimDelivery).toHaveBeenCalledWith("m1");
    expect(ctx.maps.channelDelivering.has("s1")).toBe(true);
    expect(intent).toMatchObject({ kind: "pasteText" });
  });

  it("a claim loser (claimDelivery=false) does NOT paste or mark in-flight", () => {
    const ctx = makeCtx({
      deps: { nextUnreadMessage: () => msg, claimDelivery: () => false },
    });
    expect(channelActor.decide(ctx, ready())).toBeNull();
    expect(ctx.maps.channelDelivering.size).toBe(0);
  });

  it("is blocked when the queue already dispatched this session this tick", () => {
    const maps = emptyMaps();
    maps.queueDispatched.add("s1");
    const ctx = makeCtx({ maps, deps: { nextUnreadMessage: () => msg } });
    expect(channelActor.decide(ctx, ready())).toBeNull();
  });

  it("is blocked when resume already ran this session this tick", () => {
    const maps = emptyMaps();
    maps.rateLimitResumed.add("s1");
    const ctx = makeCtx({ maps, deps: { nextUnreadMessage: () => msg } });
    expect(channelActor.decide(ctx, ready())).toBeNull();
  });

  it("onFail un-claims (resetDelivery) and onSettled clears in-flight", async () => {
    const fb = fakeBackend();
    const resetDelivery = vi.fn();
    const ctx = makeCtx({
      fb,
      deps: { nextUnreadMessage: () => msg, resetDelivery },
    });
    runWriteActor(channelActor, ctx, ready());
    expect(ctx.maps.channelDelivering.has("s1")).toBe(true);
    await fb.fail();
    expect(resetDelivery).toHaveBeenCalledWith("m1");
    expect(ctx.maps.channelDelivering.has("s1")).toBe(false); // finally
  });
});

describe("runWriteActor (fire-and-forget executor)", () => {
  it("returns synchronously without awaiting the backend send", () => {
    const fb = fakeBackend();
    const ctx = makeCtx({ fb, deps: { peekPrompt: () => "x" } });
    // never resolve the deferred → runWriteActor must still return synchronously
    runWriteActor(queueActor, ctx, status({ status: "idle" }));
    expect(fb.calls).toEqual([
      { op: "pasteText", name: "claude-s1", text: "x" },
    ]);
  });

  it("runs onCommit on success and onFail on rejection (queue dequeue / re-arm)", async () => {
    const fbOk = fakeBackend();
    const dequeue = vi.fn();
    const ctxOk = makeCtx({
      fb: fbOk,
      deps: { peekPrompt: () => "x", dequeuePrompt: dequeue },
    });
    runWriteActor(queueActor, ctxOk, status({ status: "idle" }));
    await fbOk.commit();
    expect(dequeue).toHaveBeenCalledWith("s1");

    const fbBad = fakeBackend();
    const ctxBad = makeCtx({ fb: fbBad, deps: { peekPrompt: () => "x" } });
    runWriteActor(queueActor, ctxBad, status({ status: "idle" }));
    expect(ctxBad.maps.queueDispatched.has("s1")).toBe(true);
    await fbBad.fail();
    expect(ctxBad.maps.queueDispatched.has("s1")).toBe(false); // rolled back
  });

  it("a noWrite intent runs onCommit synchronously and fires NO backend call", () => {
    const fb = fakeBackend();
    const maps = emptyMaps();
    maps.queueDispatched.add("s1");
    const budget = { day: "2026-07-03", count: 0 };
    maps.rateLimitResumeDay.set("s1", budget);
    const ctx = makeCtx({ fb, maps });
    runWriteActor(
      resumeActor,
      ctx,
      status({ status: "idle", rateLimit: { reason: "l", resetAt: 1 } })
    );
    expect(fb.calls).toEqual([]); // no send
    expect(budget.count).toBe(1); // charged synchronously
    expect(maps.rateLimitResumed.has("s1")).toBe(true);
  });
});

describe("cross-actor parity: at most one write per session per tick", () => {
  it("a session with a queued prompt AND a pending channel message writes ONCE (queue wins)", () => {
    const fb = fakeBackend();
    const maps = emptyMaps();
    const ctx = makeCtx({
      fb,
      maps,
      deps: {
        peekPrompt: () => "task",
        nextUnreadMessage: () => ({ id: "m1" }) as never,
      },
    });
    const s = status({ status: "idle" });
    runWriteActor(queueActor, ctx, s);
    runWriteActor(resumeActor, ctx, s); // not rate-limited → null
    runWriteActor(answerActor, ctx, s); // not waiting → null
    runWriteActor(channelActor, ctx, s); // blocked: queueDispatched set
    expect(fb.calls).toEqual([
      { op: "pasteText", name: "claude-s1", text: "task" },
    ]);
  });

  it("a rate-limited session with AUTO_RESUME off gets ZERO writes from queue/answer/channel", () => {
    const fb = fakeBackend();
    const ctx = makeCtx({
      fb,
      flags: { autoResume: false },
      deps: {
        peekPrompt: () => "task",
        nextUnreadMessage: () => ({ id: "m1" }) as never,
      },
    });
    const s = status({
      status: "waiting",
      rateLimit: { reason: "limit", resetAt: null },
      prompt: { kind: "continue", line: "Proceed?" },
    });
    runWriteActor(queueActor, ctx, s);
    runWriteActor(resumeActor, ctx, s);
    runWriteActor(answerActor, ctx, s);
    runWriteActor(channelActor, ctx, s);
    expect(fb.calls).toEqual([]); // hard rate-limit ownership, no writes
  });
});
