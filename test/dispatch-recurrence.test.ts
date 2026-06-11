/**
 * Cron recurrence (#7): the pure next-occurrence math + the reconciler's re-arm
 * planning (a due recurring local task promotes AND schedules its next instance).
 */
import { describe, it, expect } from "vitest";
import {
  nextOccurrence,
  normalizeRecurrence,
  recurrenceLabel,
} from "@/lib/dispatch/recurrence";
import { planScheduledPromotion } from "@/lib/dispatch/reconciler";
import type { IssueDispatch } from "@/lib/dispatch/types";

const NOW = Date.parse("2026-06-06T12:00:00.000Z");

describe("nextOccurrence", () => {
  it("advances by the interval from the scheduled time", () => {
    expect(nextOccurrence("hourly", "2026-06-06T11:30:00.000Z", NOW)).toBe(
      "2026-06-06T12:30:00.000Z"
    );
    expect(nextOccurrence("daily", "2026-06-06T09:00:00.000Z", NOW)).toBe(
      "2026-06-07T09:00:00.000Z"
    );
    expect(nextOccurrence("weekly", "2026-06-06T09:00:00.000Z", NOW)).toBe(
      "2026-06-13T09:00:00.000Z"
    );
  });

  it("skips missed occurrences in one jump (no catch-up storm after downtime)", () => {
    // A daily 09:00 task last fired 3 days ago; today's 09:00 already passed at
    // NOW=12:00, so the next future occurrence is tomorrow 09:00 — not a backlog.
    expect(nextOccurrence("daily", "2026-06-03T09:00:00.000Z", NOW)).toBe(
      "2026-06-07T09:00:00.000Z"
    );
    expect(nextOccurrence("hourly", "2026-06-03T11:30:00.000Z", NOW)).toBe(
      "2026-06-06T12:30:00.000Z"
    );
  });

  it("returns null for once / null / unknown", () => {
    expect(nextOccurrence("once", "2026-06-06T11:00:00.000Z", NOW)).toBeNull();
    expect(nextOccurrence(null, "2026-06-06T11:00:00.000Z", NOW)).toBeNull();
    expect(
      nextOccurrence("monthly", "2026-06-06T11:00:00.000Z", NOW)
    ).toBeNull();
  });

  it("rejects inherited Object.prototype keys (no reconciler-halting RangeError)", () => {
    // `"toString" in INTERVAL_MS` is true — using `in` here would read an
    // inherited function and throw inside the reconciler tick, halting the fleet.
    for (const k of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
      expect(normalizeRecurrence(k)).toBeNull();
      expect(nextOccurrence(k, "2026-06-06T11:00:00.000Z", NOW)).toBeNull();
    }
  });

  it("falls back to now+interval when the from-time is missing/unparseable", () => {
    expect(nextOccurrence("hourly", null, NOW)).toBe(
      "2026-06-06T13:00:00.000Z"
    );
    expect(nextOccurrence("daily", "junk", NOW)).toBe(
      "2026-06-07T12:00:00.000Z"
    );
  });
});

describe("normalizeRecurrence + recurrenceLabel", () => {
  it("normalizes valid keywords, else null", () => {
    expect(normalizeRecurrence("daily")).toBe("daily");
    expect(normalizeRecurrence("hourly")).toBe("hourly");
    expect(normalizeRecurrence("once")).toBeNull();
    expect(normalizeRecurrence("")).toBeNull();
    expect(normalizeRecurrence(undefined)).toBeNull();
    expect(normalizeRecurrence("hacky")).toBeNull();
  });

  it("labels recurring tasks for the scheduled list", () => {
    expect(recurrenceLabel("daily")).toBe("repeats daily");
    expect(recurrenceLabel("hourly")).toBe("repeats hourly");
    expect(recurrenceLabel(null)).toBeNull();
    expect(recurrenceLabel("once")).toBeNull();
  });
});

describe("planScheduledPromotion (re-arm recurring local tasks)", () => {
  const row = (over: Partial<IssueDispatch>): IssueDispatch =>
    ({
      id: "x",
      repo_id: "r1",
      issue_number: 0,
      issue_title: "Nightly bump",
      task_body: "bump deps",
      scheduled_at: "2026-06-06T11:00:00.000Z",
      recurrence: null,
      source: "local",
      auto_merge: 0,
      ...over,
    }) as unknown as IssueDispatch;

  it("promotes a due recurring local task AND re-arms its next occurrence", () => {
    const { promoteIds, reArms } = planScheduledPromotion(
      [row({ id: "rec", recurrence: "daily" })],
      NOW
    );
    expect(promoteIds).toEqual(["rec"]);
    expect(reArms).toHaveLength(1);
    expect(reArms[0]).toMatchObject({
      repoId: "r1",
      title: "Nightly bump",
      taskBody: "bump deps",
      recurrence: "daily",
      autoMerge: 0,
    });
    expect(reArms[0].scheduledAt).toBe("2026-06-07T11:00:00.000Z");
  });

  it("a non-recurring due task promotes but is NOT re-armed", () => {
    const { promoteIds, reArms } = planScheduledPromotion(
      [row({ id: "once", recurrence: null })],
      NOW
    );
    expect(promoteIds).toEqual(["once"]);
    expect(reArms).toEqual([]);
  });

  it("a NOT-due recurring task is neither promoted nor re-armed", () => {
    const { promoteIds, reArms } = planScheduledPromotion(
      [
        row({
          id: "future",
          recurrence: "daily",
          scheduled_at: "2026-06-06T13:00:00.000Z",
        }),
      ],
      NOW
    );
    expect(promoteIds).toEqual([]);
    expect(reArms).toEqual([]);
  });

  it("a GitHub row with a stray recurrence is NOT re-armed (local-only)", () => {
    const { reArms } = planScheduledPromotion(
      [
        row({
          id: "gh",
          source: "github",
          issue_number: 5,
          recurrence: "daily",
        }),
      ],
      NOW
    );
    expect(reArms).toEqual([]);
  });

  it("carries auto_merge onto the re-armed clone", () => {
    const { reArms } = planScheduledPromotion(
      [row({ id: "am", recurrence: "weekly", auto_merge: 1 })],
      NOW
    );
    expect(reArms[0].autoMerge).toBe(1);
  });
});
