/**
 * Conflict-aware decomposition — the co-scheduling guard (pickSchedulable). No-claims
 * rows behave exactly like pickCandidates (today's pipeline unchanged); overlapping
 * claims serialize within a tick AND across ticks (against live claims); the cap is
 * never exceeded.
 */
import { describe, it, expect } from "vitest";
import { pickSchedulable, pickCandidates } from "../lib/dispatch/reconciler";
import type { IssueDispatch } from "../lib/dispatch/types";

const row = (id: string, claims: string[] | null): IssueDispatch =>
  ({
    id,
    file_claims: claims ? JSON.stringify(claims) : null,
  }) as IssueDispatch;

describe("pickSchedulable", () => {
  it("no-claims rows behave exactly like pickCandidates (regression guard)", () => {
    const pending = [row("a", null), row("b", null), row("c", null)];
    expect(pickSchedulable(pending, [], 2).map((r) => r.id)).toEqual(
      pickCandidates(pending, 2).map((r) => r.id)
    );
  });

  it("serializes two overlapping pending rows within a tick (FIFO-first wins)", () => {
    const pending = [row("a", ["lib/x"]), row("b", ["lib/x/y.ts"])];
    const picked = pickSchedulable(pending, [], 2).map((r) => r.id);
    expect(picked).toEqual(["a"]); // b skipped — overlaps a
  });

  it("a skip is not a hard stop — a later DISJOINT row is still picked", () => {
    const pending = [
      row("a", ["lib/x"]),
      row("b", ["lib/x/y.ts"]), // conflicts a → skip
      row("c", ["lib/z"]), // disjoint → picked
    ];
    expect(pickSchedulable(pending, [], 2).map((r) => r.id)).toEqual([
      "a",
      "c",
    ]);
  });

  it("skips a pending row that conflicts a LIVE claim, even with slots free (cross-tick)", () => {
    const pending = [row("a", ["lib/x/y.ts"]), row("b", ["lib/z"])];
    const live = [["lib/x"]]; // a dispatched/pr_open row holds lib/x
    expect(pickSchedulable(pending, live, 5).map((r) => r.id)).toEqual(["b"]);
  });

  it("disjoint claims all schedule (parallelism preserved); never exceeds slots", () => {
    const pending = [
      row("a", ["lib/a"]),
      row("b", ["lib/b"]),
      row("c", ["lib/c"]),
    ];
    expect(pickSchedulable(pending, [], 3).map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(pickSchedulable(pending, [], 2)).toHaveLength(2);
    expect(pickSchedulable(pending, [], 0)).toEqual([]);
  });
});
