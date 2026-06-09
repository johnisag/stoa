import { describe, it, expect } from "vitest";
import { dueDispatchIds } from "../lib/dispatch/reconciler";

const now = Date.parse("2026-06-06T12:00:00.000Z");

describe("dueDispatchIds", () => {
  it("returns ids whose scheduled_at is at or before now", () => {
    const rows = [
      { id: "past", scheduled_at: "2026-06-06T11:00:00.000Z" },
      { id: "now", scheduled_at: "2026-06-06T12:00:00.000Z" },
      { id: "future", scheduled_at: "2026-06-06T13:00:00.000Z" },
    ];
    expect(dueDispatchIds(rows, now)).toEqual(["past", "now"]);
  });

  it("treats null / unparseable scheduled_at as due (fail-open)", () => {
    const rows = [
      { id: "null", scheduled_at: null },
      { id: "junk", scheduled_at: "not-a-date" },
      { id: "future", scheduled_at: "2026-06-06T13:00:00.000Z" },
    ];
    expect(dueDispatchIds(rows, now)).toEqual(["null", "junk"]);
  });

  it("returns [] when nothing is due", () => {
    expect(
      dueDispatchIds(
        [{ id: "future", scheduled_at: "2026-06-06T13:00:00.000Z" }],
        now
      )
    ).toEqual([]);
  });
});
