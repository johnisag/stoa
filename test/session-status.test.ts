/**
 * Locks the pure diff the /ws/events broadcaster uses to decide which session
 * status transitions to push. Only changed/new entries go on the wire; the
 * client status poll backstops removals.
 */
import { describe, it, expect } from "vitest";
import {
  diffStatuses,
  snapshotStatuses,
  type ManagedStatus,
} from "@/lib/session-status";

const wt = (
  id: string,
  status: ManagedStatus["status"],
  lastLine = ""
): ManagedStatus => ({ id, name: `claude-${id}`, status, lastLine });

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
      { id: "a", name: "claude-a", status: "waiting", lastLine: "" },
    ]);
  });

  it("treats a changed lastLine as a delta (drives the live preview)", () => {
    const prev = snapshotStatuses([wt("a", "running", "step 1")]);
    const deltas = diffStatuses(prev, [wt("a", "running", "step 2")]);
    expect(deltas).toEqual([
      { id: "a", name: "claude-a", status: "running", lastLine: "step 2" },
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
      { id: "b", name: "claude-b", status: "idle", lastLine: "" },
    ]);
  });
});
