/**
 * Scheduler — the service layer over a real in-memory SQLite (real schema +
 * migrations + queries, the `db` proxy mocked) plus the pure cadence helpers.
 * Locks: create (once + recurring) with session validation, the first-run-time
 * computation, the due predicate, the post-fire transition (recurring advances,
 * one-shot disables), the due query, and enable/disable + delete.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    getDb: () => state.db,
    get db() {
      return state.db;
    },
  };
});

import {
  createSchedule,
  getSchedule,
  listSchedules,
  dueSchedules,
  setScheduleEnabled,
  deleteSchedule,
  recordScheduleFired,
  fireSchedule,
  isScheduleDue,
  computeFirstRunAt,
  computeNextRunAfterFire,
  validateSchedulePrompt,
  normalizeScheduleName,
  normalizeRunAt,
  ScheduleValidationError,
  SCHEDULE_PROMPT_MAX_LENGTH,
  SCHEDULE_NAME_MAX_LENGTH,
  SCHEDULE_MAX_PER_SESSION,
} from "@/lib/scheduler";
import type { ScheduleRow } from "@/lib/db/types";

function db() {
  return state.db as InstanceType<typeof Database>;
}
function addSession(id: string) {
  db().prepare("INSERT INTO sessions (id, name) VALUES (?, ?)").run(id, id);
}

const HOUR = 3_600_000;
const T0 = Date.parse("2026-06-27T12:00:00.000Z");

beforeAll(() => {
  const d = new Database(":memory:");
  createSchema(d);
  runMigrations(d);
  state.db = d;
});

beforeEach(() => {
  db().prepare("DELETE FROM schedules").run();
  db().prepare("DELETE FROM sessions").run();
  addSession("sess-1");
});

describe("pure helpers", () => {
  it("validateSchedulePrompt rejects empty/non-string/over-long", () => {
    expect(() => validateSchedulePrompt("")).toThrow(ScheduleValidationError);
    expect(() => validateSchedulePrompt(5)).toThrow(ScheduleValidationError);
    expect(() =>
      validateSchedulePrompt("x".repeat(SCHEDULE_PROMPT_MAX_LENGTH + 1))
    ).toThrow(/exceeds/);
    expect(validateSchedulePrompt("  hi  ")).toBe("hi");
  });

  it("normalizeScheduleName: null → empty, non-string throws, over-long throws", () => {
    expect(normalizeScheduleName(null)).toBe("");
    expect(normalizeScheduleName(undefined)).toBe("");
    expect(normalizeScheduleName("  nightly  ")).toBe("nightly");
    expect(() => normalizeScheduleName(5)).toThrow(ScheduleValidationError);
    expect(() =>
      normalizeScheduleName("x".repeat(SCHEDULE_NAME_MAX_LENGTH + 1))
    ).toThrow(/exceeds/);
  });

  it("normalizeRunAt parses ISO, rejects garbage/non-string, allows null", () => {
    expect(normalizeRunAt(null)).toBeNull();
    expect(normalizeRunAt("")).toBeNull();
    expect(normalizeRunAt("2026-06-27T12:00:00Z")).toBe(
      "2026-06-27T12:00:00.000Z"
    );
    expect(() => normalizeRunAt("not a date")).toThrow(/valid date/);
    expect(() => normalizeRunAt(5)).toThrow(ScheduleValidationError); // non-string
  });

  it("computeFirstRunAt: future runAt wins; no-runAt recurring = now+interval, once = now", () => {
    // A FUTURE explicit runAt is used verbatim (recurring or one-shot).
    expect(computeFirstRunAt("daily", "2026-12-01T00:00:00.000Z", T0)).toBe(
      "2026-12-01T00:00:00.000Z"
    );
    expect(computeFirstRunAt(null, "2026-12-01T00:00:00.000Z", T0)).toBe(
      "2026-12-01T00:00:00.000Z"
    );
    // No runAt: recurring fires one interval out; one-shot fires now.
    expect(computeFirstRunAt("hourly", null, T0)).toBe(
      new Date(T0 + HOUR).toISOString()
    );
    expect(computeFirstRunAt(null, null, T0)).toBe(new Date(T0).toISOString());
  });

  it("computeFirstRunAt: a PAST runAt advances a recurring to its next grid slot, but fires a one-shot ASAP", () => {
    const pastNine = "2026-06-27T09:00:00.000Z"; // 3h before T0 (12:00)
    // Recurring "daily" anchored at a past 09:00 → next fire is tomorrow 09:00,
    // NOT immediately on create.
    expect(computeFirstRunAt("daily", pastNine, T0)).toBe(
      new Date(Date.parse(pastNine) + 86_400_000).toISOString()
    );
    // A one-shot with a past runAt is "run once, now" → used verbatim (due ASAP).
    expect(computeFirstRunAt(null, pastNine, T0)).toBe(pastNine);
  });

  it("computeNextRunAfterFire: once → null (stop); recurring → next occurrence", () => {
    expect(
      computeNextRunAfterFire(null, new Date(T0).toISOString(), T0)
    ).toBeNull();
    expect(
      computeNextRunAfterFire("hourly", new Date(T0).toISOString(), T0)
    ).toBe(new Date(T0 + HOUR).toISOString());
  });

  it("isScheduleDue: enabled + past = due; disabled or future = not", () => {
    const base: ScheduleRow = {
      id: "x",
      name: "",
      session_id: "sess-1",
      prompt: "p",
      recurrence: null,
      next_run_at: new Date(T0).toISOString(),
      last_run_at: null,
      enabled: 1,
      created_at: "",
      updated_at: "",
    };
    expect(isScheduleDue(base, T0 + 1)).toBe(true);
    expect(isScheduleDue(base, T0 - 1)).toBe(false); // not yet
    expect(isScheduleDue({ ...base, enabled: 0 }, T0 + 1)).toBe(false); // paused
  });
});

describe("createSchedule", () => {
  it("creates a one-shot with an explicit runAt", () => {
    const s = createSchedule({
      sessionId: "sess-1",
      prompt: "run the tests",
      runAt: "2026-06-28T02:00:00Z",
      name: "nightly",
      nowMs: T0,
    });
    expect(s.id).toBeTruthy();
    expect(s.session_id).toBe("sess-1");
    expect(s.prompt).toBe("run the tests");
    expect(s.recurrence).toBeNull();
    expect(s.next_run_at).toBe("2026-06-28T02:00:00.000Z");
    expect(s.enabled).toBe(1);
  });

  it("creates a recurring schedule firing one interval out by default", () => {
    const s = createSchedule({
      sessionId: "sess-1",
      prompt: "daily summary",
      recurrence: "daily",
      nowMs: T0,
    });
    expect(s.recurrence).toBe("daily");
    expect(s.next_run_at).toBe(new Date(T0 + 86_400_000).toISOString());
  });

  it("rejects an unknown session, a missing sessionId, and a missing prompt", () => {
    expect(() => createSchedule({ sessionId: "ghost", prompt: "p" })).toThrow(
      /no session with id/
    );
    expect(() => createSchedule({ sessionId: "", prompt: "p" })).toThrow(
      /sessionId is required/
    );
    expect(() => createSchedule({ sessionId: "sess-1", prompt: "" })).toThrow(
      /prompt is required/
    );
  });

  it("caps the number of enabled schedules per session", () => {
    for (let i = 0; i < SCHEDULE_MAX_PER_SESSION; i++) {
      createSchedule({ sessionId: "sess-1", prompt: `p${i}`, nowMs: T0 });
    }
    expect(() =>
      createSchedule({ sessionId: "sess-1", prompt: "one too many" })
    ).toThrow(/too many active schedules/);
    // A disabled schedule frees a slot (only ENABLED ones count).
    const all = listSchedules();
    setScheduleEnabled(all[0].id, false);
    expect(() =>
      createSchedule({ sessionId: "sess-1", prompt: "now there's room" })
    ).not.toThrow();
  });
});

describe("recordScheduleFired (post-fire transition)", () => {
  it("a one-shot is stamped and disabled", () => {
    const s = createSchedule({
      sessionId: "sess-1",
      prompt: "p",
      runAt: new Date(T0).toISOString(),
      nowMs: T0,
    });
    const after = recordScheduleFired(s, T0 + 1);
    expect(after?.enabled).toBe(0);
    expect(after?.last_run_at).not.toBeNull();
  });

  it("a recurring schedule advances on-grid (anchored to next_run_at, not nowMs) and stays enabled", () => {
    // next_run_at = T0+1h (a future runAt, used verbatim). Fire it 1.5h LATE
    // (nowMs = T0+2.5h). Anchored to next_run_at the next slot is T0+3h (the first
    // grid point after now); anchored to nowMs it would be T0+3.5h — so this
    // fixture actually distinguishes the two and locks the anti-drift guarantee.
    const s = createSchedule({
      sessionId: "sess-1",
      prompt: "p",
      recurrence: "hourly",
      runAt: new Date(T0 + HOUR).toISOString(),
      nowMs: T0,
    });
    expect(s.next_run_at).toBe(new Date(T0 + HOUR).toISOString());
    const after = recordScheduleFired(s, T0 + 2.5 * HOUR);
    expect(after?.enabled).toBe(1);
    expect(after?.last_run_at).not.toBeNull();
    expect(after?.next_run_at).toBe(new Date(T0 + 3 * HOUR).toISOString());
  });
});

describe("fireSchedule (the tick's per-row body)", () => {
  it("advances the DB row BEFORE it enqueues, and keeps a recurring schedule enabled", () => {
    const s = createSchedule({
      sessionId: "sess-1",
      prompt: "run tests",
      recurrence: "hourly",
      runAt: new Date(T0 + HOUR).toISOString(), // next_run_at = T0+1h
      nowMs: T0,
    });
    const calls: Array<[string, string]> = [];
    let nextRunAtSeenByEnqueue: string | undefined;
    const outcome = fireSchedule(s, T0 + HOUR, (id, p) => {
      calls.push([id, p]);
      // The record-before-enqueue ordering: by the time we enqueue, the row's
      // next_run_at must already be advanced (so a later double-fire can't happen).
      nextRunAtSeenByEnqueue = getSchedule(s.id)?.next_run_at;
    });
    expect(outcome).toBe("fired");
    expect(calls).toEqual([["sess-1", "run tests"]]);
    expect(nextRunAtSeenByEnqueue).toBe(new Date(T0 + 2 * HOUR).toISOString());
    expect(getSchedule(s.id)?.enabled).toBe(1); // recurring stays enabled
  });

  it("disables (does NOT enqueue) when the target session is gone", () => {
    const s = createSchedule({
      sessionId: "sess-1",
      prompt: "p",
      runAt: new Date(T0).toISOString(),
      nowMs: T0,
    });
    db().prepare("DELETE FROM sessions WHERE id = ?").run("sess-1");
    const calls: Array<[string, string]> = [];
    const outcome = fireSchedule(s, T0 + 1, (id, p) => calls.push([id, p]));
    expect(outcome).toBe("session-gone");
    expect(calls).toHaveLength(0); // never enqueued into a dead session
    expect(getSchedule(s.id)?.enabled).toBe(0); // stopped, not churning
  });
});

describe("dueSchedules / list / enable / delete", () => {
  it("dueSchedules returns only enabled rows whose time has passed", () => {
    const due = createSchedule({
      sessionId: "sess-1",
      prompt: "due",
      runAt: new Date(T0 - HOUR).toISOString(),
      nowMs: T0,
    });
    createSchedule({
      sessionId: "sess-1",
      prompt: "future",
      runAt: new Date(T0 + HOUR).toISOString(),
      nowMs: T0,
    });
    const paused = createSchedule({
      sessionId: "sess-1",
      prompt: "paused",
      runAt: new Date(T0 - HOUR).toISOString(),
      nowMs: T0,
    });
    setScheduleEnabled(paused.id, false);

    const ids = dueSchedules(T0).map((r) => r.id);
    expect(ids).toContain(due.id);
    expect(ids).not.toContain(paused.id);
    expect(dueSchedules(T0)).toHaveLength(1);
  });

  it("treats a schedule due at EXACTLY now as due (<=, not <)", () => {
    const exact = createSchedule({
      sessionId: "sess-1",
      prompt: "exact",
      runAt: new Date(T0).toISOString(), // one-shot, next_run_at = T0 exactly
      nowMs: T0,
    });
    expect(dueSchedules(T0).map((r) => r.id)).toContain(exact.id);
  });

  it("enable/disable round-trips and delete removes", () => {
    const s = createSchedule({
      sessionId: "sess-1",
      prompt: "p",
      recurrence: "daily",
      nowMs: T0,
    });
    expect(setScheduleEnabled(s.id, false)?.enabled).toBe(0);
    expect(setScheduleEnabled(s.id, true)?.enabled).toBe(1);
    expect(setScheduleEnabled("nope", true)).toBeNull();
    expect(listSchedules()).toHaveLength(1);
    expect(deleteSchedule(s.id)).toBe(true);
    expect(getSchedule(s.id)).toBeNull();
    expect(deleteSchedule(s.id)).toBe(false);
  });
});
