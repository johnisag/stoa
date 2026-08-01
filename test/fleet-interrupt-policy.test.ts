import { describe, expect, it } from "vitest";
import {
  FLEET_INTERRUPT_DEFAULT_GRACE_MS,
  FLEET_INTERRUPT_MAX_GRACE_MS,
  FLEET_INTERRUPT_MIN_GRACE_MS,
  decideFleetInterruptAction,
  decideFleetResume,
  parseFleetCancelRequest,
  parseFleetPauseRequest,
  startFleetWorkerInterrupt,
  type FleetInterruptWorkerSnapshot,
} from "@/lib/fleet/interrupt-policy";

const NOW = new Date("2026-08-01T12:00:00.000Z");

function worker(
  overrides: Partial<FleetInterruptWorkerSnapshot> = {}
): FleetInterruptWorkerSnapshot {
  return {
    runId: "run-1",
    workerId: "worker-1",
    sessionId: "session-1",
    workerStatus: "running",
    interruptRequestedAt: null,
    interruptDeadlineAt: null,
    noticeState: "unattempted",
    stopState: "unattempted",
    ...overrides,
  };
}

describe("Fleet pause and destructive-cancel parsing", () => {
  it("parses both pause modes with a strictly bounded grace period", () => {
    expect(parseFleetPauseRequest({})).toEqual({
      ok: true,
      value: { mode: "pause-new", graceMs: null },
    });
    expect(parseFleetPauseRequest({ mode: "pause-and-interrupt" })).toEqual({
      ok: true,
      value: {
        mode: "pause-and-interrupt",
        graceMs: FLEET_INTERRUPT_DEFAULT_GRACE_MS,
      },
    });
    expect(
      parseFleetPauseRequest({
        mode: "pause-and-interrupt",
        graceMs: FLEET_INTERRUPT_MIN_GRACE_MS,
      })
    ).toMatchObject({ ok: true });
    expect(
      parseFleetPauseRequest({
        mode: "pause-and-interrupt",
        graceMs: FLEET_INTERRUPT_MAX_GRACE_MS + 1,
      })
    ).toMatchObject({ ok: false });
    expect(
      parseFleetPauseRequest({ mode: "pause-new", graceMs: 30_000 })
    ).toMatchObject({ ok: false });
    expect(parseFleetPauseRequest({ mode: "pause-all" })).toMatchObject({
      ok: false,
    });
  });

  it("requires exact run-id confirmation for destructive cleanup", () => {
    expect(parseFleetCancelRequest("run-1", {})).toEqual({
      ok: true,
      value: {
        mode: "cancel-preserve-worktrees",
        destructiveCleanupConfirmed: false,
        previewDigest: null,
      },
    });
    const destructive = {
      mode: "cancel-and-clean-owned-worktrees",
      confirm: true,
      confirmation: "run-1",
      previewDigest: "a".repeat(64),
    };
    expect(parseFleetCancelRequest("run-1", destructive)).toEqual({
      ok: true,
      value: {
        mode: "cancel-and-clean-owned-worktrees",
        destructiveCleanupConfirmed: true,
        previewDigest: "a".repeat(64),
      },
    });
    for (const confirmation of ["RUN-1", "run-1 ", "", null]) {
      expect(
        parseFleetCancelRequest("run-1", {
          ...destructive,
          confirmation,
        })
      ).toMatchObject({ ok: false });
    }
    expect(
      parseFleetCancelRequest("run-1", { ...destructive, confirm: 1 })
    ).toMatchObject({ ok: false });
  });

  it("fails safely when a hostile request getter throws", () => {
    const payload = Object.defineProperty({}, "mode", {
      get() {
        throw new Error("boom");
      },
    });
    expect(parseFleetPauseRequest(payload)).toEqual({
      ok: false,
      error: "pause request could not be read safely",
    });
  });
});

describe("Fleet interrupt restart policy", () => {
  it("creates one deadline and preserves it exactly on restart replay", () => {
    const initial = startFleetWorkerInterrupt(worker(), NOW);
    expect(initial).toEqual({
      ok: true,
      request: {
        requestedAt: NOW.toISOString(),
        deadlineAt: new Date(
          NOW.getTime() + FLEET_INTERRUPT_DEFAULT_GRACE_MS
        ).toISOString(),
        created: true,
      },
      resolved: false,
    });
    if (!initial.ok || !initial.request) throw new Error("expected request");
    const durable = worker({
      interruptRequestedAt: initial.request.requestedAt,
      interruptDeadlineAt: initial.request.deadlineAt,
    });

    expect(
      startFleetWorkerInterrupt(
        durable,
        new Date(NOW.getTime() + 2_000),
        FLEET_INTERRUPT_MAX_GRACE_MS
      )
    ).toEqual({
      ok: true,
      request: { ...initial.request, created: false },
      resolved: false,
    });
  });

  it("delivers one notice, waits, then stops at the exact deadline", () => {
    const requestedAt = NOW.toISOString();
    const deadline = new Date(NOW.getTime() + FLEET_INTERRUPT_DEFAULT_GRACE_MS);
    const pending = worker({
      interruptRequestedAt: requestedAt,
      interruptDeadlineAt: deadline.toISOString(),
    });

    expect(decideFleetInterruptAction(pending, NOW)).toMatchObject({
      kind: "deliver_notice",
      replay: false,
      requestedAt,
      deadlineAt: deadline.toISOString(),
    });
    expect(
      decideFleetInterruptAction(
        { ...pending, noticeState: "requested" },
        new Date(NOW.getTime() + 1_000)
      )
    ).toMatchObject({ kind: "deliver_notice", replay: true });
    expect(
      decideFleetInterruptAction(
        { ...pending, noticeState: "delivered" },
        new Date(NOW.getTime() + 10_000)
      )
    ).toMatchObject({ kind: "wait_for_deadline", replay: false });
    expect(
      decideFleetInterruptAction(
        { ...pending, noticeState: "failed" },
        deadline
      )
    ).toMatchObject({ kind: "stop_session", replay: false });
  });

  it("replays an unconfirmed deadline stop but never a confirmed stop", () => {
    const requestedAt = NOW.toISOString();
    const deadline = new Date(NOW.getTime() + FLEET_INTERRUPT_MIN_GRACE_MS);
    const durable = worker({
      interruptRequestedAt: requestedAt,
      interruptDeadlineAt: deadline.toISOString(),
      noticeState: "delivered",
      stopState: "requested",
    });
    const afterRestart = new Date(deadline.getTime() + 1);

    expect(decideFleetInterruptAction(durable, afterRestart)).toMatchObject({
      kind: "stop_session",
      replay: true,
    });
    expect(
      decideFleetInterruptAction(
        { ...durable, stopState: "confirmed" },
        afterRestart
      )
    ).toEqual({
      kind: "none",
      reason: "stop_confirmed",
      resolved: false,
    });
  });

  it("blocks resume until interrupted workers are terminal", () => {
    const interrupted = worker({
      interruptRequestedAt: NOW.toISOString(),
      interruptDeadlineAt: new Date(
        NOW.getTime() + FLEET_INTERRUPT_DEFAULT_GRACE_MS
      ).toISOString(),
      noticeState: "delivered",
    });

    expect(decideFleetResume([interrupted])).toEqual({
      allowed: false,
      blockingWorkerIds: ["worker-1"],
      reasons: ["an interrupt remains active"],
    });
    expect(
      decideFleetResume([
        { ...interrupted, workerStatus: "cleanup_complete", sessionId: null },
      ])
    ).toEqual({ allowed: true, blockingWorkerIds: [], reasons: [] });
  });

  it("fails closed on partial, malformed, or impossible durable state", () => {
    const partial = worker({ interruptRequestedAt: NOW.toISOString() });
    expect(decideFleetInterruptAction(partial, NOW)).toMatchObject({
      kind: "operator_attention",
      reason: "interrupt timestamps are incomplete",
    });
    expect(
      decideFleetInterruptAction(
        worker({
          workerStatus: "mystery",
          interruptRequestedAt: NOW.toISOString(),
          interruptDeadlineAt: new Date(
            NOW.getTime() + FLEET_INTERRUPT_DEFAULT_GRACE_MS
          ).toISOString(),
        }),
        NOW
      )
    ).toMatchObject({ kind: "operator_attention" });
    expect(decideFleetResume([partial])).toMatchObject({
      allowed: false,
      blockingWorkerIds: ["worker-1"],
    });
    expect(
      startFleetWorkerInterrupt(worker({ sessionId: null }), NOW)
    ).toMatchObject({ ok: false });
  });

  it("blocks duplicate worker identities instead of choosing a stale attempt", () => {
    expect(decideFleetResume([worker(), worker()])).toEqual({
      allowed: false,
      blockingWorkerIds: ["worker-1"],
      reasons: ["duplicate worker interrupt identity"],
    });
  });
});
