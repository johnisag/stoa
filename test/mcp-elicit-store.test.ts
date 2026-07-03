/**
 * MCP elicitation store (#48) — the in-memory bridge between the MCP tool's poll
 * and the operator's answer. Contract: an answer lands ONCE (a stale/expired/
 * duplicate reply is rejected — the TOCTOU guard), pending requests expire after
 * the TTL, and a per-conductor cap bounds a runaway agent. Time is injected so
 * expiry is deterministic (no Date.now flake).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createElicit,
  getElicit,
  answerElicit,
  listPending,
  sweepExpired,
  _resetElicitStore,
  ELICIT_TTL_MS,
  MAX_PENDING_PER_CONDUCTOR,
} from "@/lib/mcp/elicit-store";
import type { ElicitRequest } from "@/lib/mcp/elicit-schema";

const REQ: ElicitRequest = {
  message: "Pick one",
  fields: [{ key: "target", type: "enum", enumValues: ["a", "b"] }],
};

beforeEach(() => _resetElicitStore());

describe("createElicit / getElicit", () => {
  it("registers a pending request round-trippable by id", () => {
    const r = createElicit("sess", REQ, 1000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = getElicit(r.id, 1000);
    expect(e).toMatchObject({
      conductorId: "sess",
      message: "Pick one",
      status: "pending",
    });
  });

  it("caps pending requests per conductor (DoS bound)", () => {
    for (let i = 0; i < MAX_PENDING_PER_CONDUCTOR; i++) {
      expect(createElicit("sess", REQ, 1000).ok).toBe(true);
    }
    const over = createElicit("sess", REQ, 1000);
    expect(over.ok).toBe(false);
    // A different conductor is unaffected.
    expect(createElicit("other", REQ, 1000).ok).toBe(true);
  });
});

describe("answerElicit (TOCTOU / answer-once)", () => {
  it("accepts a first answer, then rejects a second (already answered)", () => {
    const r = createElicit("sess", REQ, 1000);
    if (!r.ok) throw new Error("setup");
    expect(
      answerElicit(r.id, { action: "accept", content: { target: "a" } }, 1000)
    ).toEqual({
      ok: true,
    });
    const second = answerElicit(r.id, { action: "decline" }, 1000);
    expect(second).toEqual({ ok: false, reason: "answered" });
    // The first answer stands.
    expect(getElicit(r.id, 1000)?.answer).toMatchObject({ action: "accept" });
  });

  it("rejects answering an unknown id", () => {
    expect(answerElicit("nope", { action: "cancel" }, 1000)).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  it("rejects answering an EXPIRED request", () => {
    const r = createElicit("sess", REQ, 0);
    if (!r.ok) throw new Error("setup");
    // Past the TTL → sweep flips it to expired → a late answer is refused.
    const late = answerElicit(
      r.id,
      { action: "accept", content: { target: "a" } },
      ELICIT_TTL_MS
    );
    expect(late).toEqual({ ok: false, reason: "expired" });
  });
});

describe("listPending / sweepExpired", () => {
  it("lists only pending (oldest first) and drops answered/expired", () => {
    const a = createElicit("s", REQ, 10);
    const b = createElicit("s", REQ, 20);
    if (!a.ok || !b.ok) throw new Error("setup");
    answerElicit(a.id, { action: "cancel" }, 30);
    const pending = listPending(30);
    expect(pending.map((e) => e.id)).toEqual([b.id]); // a is answered
  });

  it("sweepExpired flips overdue pending entries", () => {
    createElicit("s", REQ, 0);
    expect(listPending(0)).toHaveLength(1);
    expect(sweepExpired(ELICIT_TTL_MS)).toBe(1);
    expect(listPending(ELICIT_TTL_MS)).toHaveLength(0);
  });
});
