/**
 * Dispatch slot math — the heart of the reconciler. `computeSlots` must honor
 * the daily quota AND the concurrency cap simultaneously and never go negative;
 * `pickCandidates` takes the first N of an already-FIFO-ordered list.
 */
import { describe, it, expect } from "vitest";
import { computeSlots, pickCandidates } from "@/lib/dispatch/reconciler";
import type { IssueDispatch } from "@/lib/dispatch/types";

describe("computeSlots", () => {
  it("returns the smaller of remaining daily quota and concurrency headroom", () => {
    expect(
      computeSlots({
        dailyQuota: 5,
        dailyDone: 0,
        maxConcurrency: 3,
        liveInFlight: 0,
      })
    ).toBe(3); // concurrency binds
    expect(
      computeSlots({
        dailyQuota: 5,
        dailyDone: 3,
        maxConcurrency: 10,
        liveInFlight: 0,
      })
    ).toBe(2); // daily binds
  });

  it("is zero when the daily quota is exhausted", () => {
    expect(
      computeSlots({
        dailyQuota: 3,
        dailyDone: 3,
        maxConcurrency: 5,
        liveInFlight: 0,
      })
    ).toBe(0);
  });

  it("is zero when concurrency is saturated", () => {
    expect(
      computeSlots({
        dailyQuota: 10,
        dailyDone: 0,
        maxConcurrency: 2,
        liveInFlight: 2,
      })
    ).toBe(0);
  });

  it("never goes negative (over-count on either cap)", () => {
    expect(
      computeSlots({
        dailyQuota: 3,
        dailyDone: 5,
        maxConcurrency: 5,
        liveInFlight: 0,
      })
    ).toBe(0);
    expect(
      computeSlots({
        dailyQuota: 10,
        dailyDone: 0,
        maxConcurrency: 2,
        liveInFlight: 3,
      })
    ).toBe(0);
  });

  it("a zero daily quota yields no slots (the disabled default)", () => {
    expect(
      computeSlots({
        dailyQuota: 0,
        dailyDone: 0,
        maxConcurrency: 5,
        liveInFlight: 0,
      })
    ).toBe(0);
  });
});

describe("pickCandidates", () => {
  const mk = (n: number): IssueDispatch =>
    ({ id: `d${n}`, issue_number: n }) as IssueDispatch;
  const pending = [mk(1), mk(2), mk(3)];

  it("takes the first N (FIFO order preserved by the query)", () => {
    expect(pickCandidates(pending, 2).map((d) => d.issue_number)).toEqual([
      1, 2,
    ]);
  });

  it("returns all when slots exceed the list", () => {
    expect(pickCandidates(pending, 5)).toHaveLength(3);
  });

  it("returns nothing for zero or negative slots", () => {
    expect(pickCandidates(pending, 0)).toEqual([]);
    expect(pickCandidates(pending, -1)).toEqual([]);
  });
});
