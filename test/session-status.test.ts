/**
 * Locks the pure diff the /ws/events broadcaster uses to decide which session
 * status transitions to push. Only changed/new entries go on the wire; the
 * client status poll backstops removals.
 */
import { describe, it, expect } from "vitest";
import {
  diffStatuses,
  snapshotStatuses,
  detectPushEvents,
  statusById,
  type ManagedStatus,
} from "@/lib/session-status";

const PROMPT: ManagedStatus["prompt"] = { kind: "continue", line: "[Y/n]" };

const wt = (
  id: string,
  status: ManagedStatus["status"],
  lastLine = "",
  prompt: ManagedStatus["prompt"] = null
): ManagedStatus => ({
  id,
  name: `claude-${id}`,
  status,
  lastLine,
  rateLimit: null,
  prompt,
});

describe("diffStatuses", () => {
  it("emits everything against an empty snapshot (first tick)", () => {
    const curr = [wt("a", "running", "build"), wt("b", "idle")];
    const deltas = diffStatuses(new Map(), curr);
    expect(deltas.map((d) => d.id).sort()).toEqual(["a", "b"]);
  });

  it("emits only entries whose status changed", () => {
    const prev = snapshotStatuses([wt("a", "running"), wt("b", "idle")]);
    const deltas = diffStatuses(prev, [wt("a", "waiting"), wt("b", "idle")]);
    expect(deltas).toEqual([
      {
        id: "a",
        name: "claude-a",
        status: "waiting",
        lastLine: "",
        rateLimit: null,
        hasPrompt: false,
      },
    ]);
  });

  it("treats a changed lastLine as a delta (drives the live preview)", () => {
    const prev = snapshotStatuses([wt("a", "running", "step 1")]);
    const deltas = diffStatuses(prev, [wt("a", "running", "step 2")]);
    expect(deltas).toEqual([
      {
        id: "a",
        name: "claude-a",
        status: "running",
        lastLine: "step 2",
        rateLimit: null,
        hasPrompt: false,
      },
    ]);
  });

  it("a prompt appearing (while status stays 'waiting') emits a delta with hasPrompt", () => {
    const prev = snapshotStatuses([wt("a", "waiting", "done")]);
    const deltas = diffStatuses(prev, [wt("a", "waiting", "done", PROMPT)]);
    expect(deltas).toEqual([
      {
        id: "a",
        name: "claude-a",
        status: "waiting",
        lastLine: "done",
        rateLimit: null,
        hasPrompt: true,
      },
    ]);
  });

  it("emits nothing when nothing changed", () => {
    const snap = [wt("a", "running", "x"), wt("b", "waiting", "y")];
    expect(diffStatuses(snapshotStatuses(snap), snap)).toEqual([]);
  });

  it("emits a newly-appeared session", () => {
    const prev = snapshotStatuses([wt("a", "running")]);
    const deltas = diffStatuses(prev, [wt("a", "running"), wt("b", "idle")]);
    expect(deltas).toEqual([
      {
        id: "b",
        name: "claude-b",
        status: "idle",
        lastLine: "",
        rateLimit: null,
        hasPrompt: false,
      },
    ]);
  });
});

describe("detectPushEvents", () => {
  it("skips the initial tick (no previous status)", () => {
    expect(detectPushEvents(new Map(), [wt("a", "waiting")])).toEqual([]);
  });

  it("running -> waiting AT A PROMPT pushes 'waiting' (needs input)", () => {
    const prev = statusById([wt("a", "running")]);
    expect(
      detectPushEvents(prev, [wt("a", "waiting", "Allow?", PROMPT)])
    ).toEqual([{ id: "a", name: "claude-a", kind: "waiting" }]);
  });

  it("running -> waiting with NO prompt (finished its turn) pushes 'done', not 'waiting'", () => {
    // The flicker fix on the push side: a turn-end isn't an approval request.
    const prev = statusById([wt("a", "running")]);
    expect(detectPushEvents(prev, [wt("a", "waiting")])).toEqual([
      { id: "a", name: "claude-a", kind: "done" },
    ]);
  });

  it("pushes done on running/waiting -> idle", () => {
    expect(
      detectPushEvents(statusById([wt("a", "running")]), [wt("a", "idle")])
    ).toEqual([{ id: "a", name: "claude-a", kind: "done" }]);
    expect(
      detectPushEvents(statusById([wt("a", "waiting")]), [wt("a", "idle")])
    ).toEqual([{ id: "a", name: "claude-a", kind: "done" }]);
  });

  it("pushes on -> error", () => {
    expect(
      detectPushEvents(statusById([wt("a", "running")]), [wt("a", "error")])
    ).toEqual([{ id: "a", name: "claude-a", kind: "error" }]);
  });

  it("does NOT push on unchanged or idle -> running", () => {
    expect(
      detectPushEvents(statusById([wt("a", "waiting")]), [wt("a", "waiting")])
    ).toEqual([]);
    expect(
      detectPushEvents(statusById([wt("a", "idle")]), [wt("a", "running")])
    ).toEqual([]);
  });
});
