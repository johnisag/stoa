/**
 * General-purpose scheduler — fire a prompt into a session on a cadence. The basis
 * for "AI coding while you sleep": a nightly test run, a scheduled summary, a
 * periodic nudge. Both the agents (the orchestration MCP server's schedule_* tools)
 * and any human UI drive it through the SAME /api/schedules route — amux's "the
 * human UI and the agents call the exact same endpoint" pattern (item #3).
 *
 * At the due time the server (server.ts owns the side effect) ENQUEUES the prompt
 * into the target session's in-memory prompt queue (lib/prompt-queue.ts). The
 * EXISTING status ticker then delivers it the moment the session next goes idle —
 * so a scheduled prompt rides the same safe, turn-boundary path a typed-ahead
 * prompt does; the scheduler adds no new keystroke-injection surface.
 *
 * Cadence reuses Stoa's own tested recurrence math (lib/dispatch/recurrence.ts):
 * "once" (a one-shot, which disables itself after firing) or hourly/daily/weekly.
 * Full cron (a specific time-of-day / weekday) + a closed-loop "watch the output
 * for a done-pattern" follow-up + non-send actions (spawn / run a workflow) are
 * deliberate follow-ups; v1 is the cadence + the send-prompt action.
 *
 * Thin shell over the prepared statements in lib/db/queries.ts; id/validation +
 * caps live here (the DB layer stays pure SQL), mirroring lib/notes.ts.
 */

import { randomUUID } from "crypto";
import { db, queries, type ScheduleRow, type Session } from "./db";
import { normalizeRecurrence, nextOccurrence } from "./dispatch/recurrence";

/** Max schedule name length — a short label. */
export const SCHEDULE_NAME_MAX_LENGTH = 256;
/** Max prompt length — a task seed, bounded per row. */
export const SCHEDULE_PROMPT_MAX_LENGTH = 20_000;
/** Max rows returned by a list. */
export const SCHEDULE_LIST_LIMIT = 500;
/** Max ENABLED schedules targeting one session — a circuit breaker so a runaway
 * caller can't pile hundreds of due schedules onto a single session's queue. */
export const SCHEDULE_MAX_PER_SESSION = 100;

/** A validation failure (the API route maps this to a 400). */
export class ScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleValidationError";
  }
}

/** Validate + normalize the prompt: a non-empty string within the cap. Pure. */
export function validateSchedulePrompt(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ScheduleValidationError("prompt must be a string");
  }
  const prompt = raw.trim();
  if (!prompt) throw new ScheduleValidationError("prompt is required");
  if (prompt.length > SCHEDULE_PROMPT_MAX_LENGTH) {
    throw new ScheduleValidationError(
      `prompt exceeds ${SCHEDULE_PROMPT_MAX_LENGTH} characters`
    );
  }
  return prompt;
}

/** Validate + normalize the name: a trimmed string within the cap (empty ok). */
export function normalizeScheduleName(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw !== "string") {
    throw new ScheduleValidationError("name must be a string");
  }
  const name = raw.trim();
  if (name.length > SCHEDULE_NAME_MAX_LENGTH) {
    throw new ScheduleValidationError(
      `name exceeds ${SCHEDULE_NAME_MAX_LENGTH} characters`
    );
  }
  return name;
}

/** Normalize an optional `runAt` to an ISO string. Accepts an ISO/parseable date
 * string; rejects an unparseable one. Pure → unit-tested. */
export function normalizeRunAt(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") {
    throw new ScheduleValidationError("runAt must be an ISO date string");
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new ScheduleValidationError("runAt is not a valid date");
  }
  return new Date(ms).toISOString();
}

/**
 * The first fire time for a new schedule. Pure → unit-tested.
 *  - An explicit `runAt` is used as-is, EXCEPT a recurring schedule whose runAt is
 *    already in the past first fires at the next future occurrence on that anchor's
 *    grid (so "daily starting <a past 9am>" first fires at the next 9am, not
 *    immediately on create). A one-shot with a past runAt DOES fire ASAP — that's
 *    the intent of "run once at <a time that has passed>".
 *  - With no runAt, a RECURRING schedule first fires one interval from now (so
 *    "daily" doesn't fire instantly on create); a ONE-SHOT fires next tick.
 */
export function computeFirstRunAt(
  recurrence: string | null,
  runAt: string | null,
  nowMs: number
): string {
  if (runAt) {
    if (recurrence && Date.parse(runAt) <= nowMs) {
      return nextOccurrence(recurrence, runAt, nowMs) ?? runAt;
    }
    return runAt;
  }
  const nowIso = new Date(nowMs).toISOString();
  if (recurrence) {
    // nextOccurrence advances from `nowIso` by one interval (> now).
    return nextOccurrence(recurrence, nowIso, nowMs) ?? nowIso;
  }
  return nowIso;
}

/** Is a schedule due to fire at `nowMs`? Pure: enabled AND its next run has passed. */
export function isScheduleDue(row: ScheduleRow, nowMs: number): boolean {
  if (row.enabled !== 1) return false;
  const at = Date.parse(row.next_run_at);
  return !Number.isNaN(at) && at <= nowMs;
}

/**
 * The next_run_at after a fire, or null when the schedule should stop (a one-shot,
 * or a recurrence whose next occurrence can't be computed). Anchored to the row's
 * CURRENT next_run_at (not `nowMs`) so the cadence doesn't drift by tick latency.
 * Pure → unit-tested.
 */
export function computeNextRunAfterFire(
  recurrence: string | null,
  currentNextRunAt: string,
  nowMs: number
): string | null {
  if (!normalizeRecurrence(recurrence)) return null; // one-shot → stop
  return nextOccurrence(recurrence, currentNextRunAt, nowMs);
}

/** Create a schedule. Validates, requires the target session to exist, computes
 * the first fire time, and stores the row. */
export function createSchedule(input: {
  name?: unknown;
  sessionId: unknown;
  prompt: unknown;
  recurrence?: unknown;
  runAt?: unknown;
  nowMs?: number;
}): ScheduleRow {
  const name = normalizeScheduleName(input.name);
  if (typeof input.sessionId !== "string" || !input.sessionId.trim()) {
    throw new ScheduleValidationError("sessionId is required");
  }
  const sessionId = input.sessionId.trim();
  const prompt = validateSchedulePrompt(input.prompt);
  const recurrence = normalizeRecurrence(input.recurrence);
  const runAt = normalizeRunAt(input.runAt);
  if (!(queries.getSession(db).get(sessionId) as Session | undefined)) {
    throw new ScheduleValidationError(`no session with id "${sessionId}"`);
  }
  const { n } = queries.countEnabledSchedulesForSession(db).get(sessionId) as {
    n: number;
  };
  if (n >= SCHEDULE_MAX_PER_SESSION) {
    throw new ScheduleValidationError(
      `too many active schedules for this session (max ${SCHEDULE_MAX_PER_SESSION}) — delete some first`
    );
  }
  const nowMs = input.nowMs ?? Date.now();
  const nextRunAt = computeFirstRunAt(recurrence, runAt, nowMs);
  const id = randomUUID();
  queries
    .createSchedule(db)
    .run(id, name, sessionId, prompt, recurrence, nextRunAt, 1);
  return queries.getSchedule(db).get(id) as ScheduleRow;
}

/** Read one schedule by id, or null. */
export function getSchedule(id: string): ScheduleRow | null {
  return (queries.getSchedule(db).get(id) as ScheduleRow | undefined) ?? null;
}

/** List schedules (enabled first, then soonest next-run), bounded. */
export function listSchedules(): ScheduleRow[] {
  return queries.listSchedules(db).all(SCHEDULE_LIST_LIMIT) as ScheduleRow[];
}

/** The enabled schedules due to fire at `nowMs` (the tick reads these). */
export function dueSchedules(nowMs: number): ScheduleRow[] {
  return queries
    .listDueSchedules(db)
    .all(new Date(nowMs).toISOString(), SCHEDULE_LIST_LIMIT) as ScheduleRow[];
}

/** Enable/disable a schedule. Returns the updated row, or null when it's gone. */
export function setScheduleEnabled(
  id: string,
  enabled: boolean
): ScheduleRow | null {
  if (!getSchedule(id)) return null;
  queries.setScheduleEnabled(db).run(enabled ? 1 : 0, id);
  return getSchedule(id);
}

/** Delete a schedule. Returns true when a row was removed. */
export function deleteSchedule(id: string): boolean {
  return queries.deleteSchedule(db).run(id).changes > 0;
}

/**
 * Record that a schedule fired at `nowMs`: a recurring one advances to its next
 * occurrence; a one-shot (or an un-advanceable recurrence) is stamped + disabled.
 * The DB transition only — server.ts owns the enqueue side effect. Returns the
 * updated row, or null if it was deleted concurrently (between the snapshot and
 * the write).
 */
export function recordScheduleFired(
  row: ScheduleRow,
  nowMs: number
): ScheduleRow | null {
  const nowIso = new Date(nowMs).toISOString();
  const next = computeNextRunAfterFire(row.recurrence, row.next_run_at, nowMs);
  if (next) {
    queries.advanceSchedule(db).run(nowIso, next, row.id);
  } else {
    queries.markScheduleFiredOnce(db).run(nowIso, row.id);
  }
  return (
    (queries.getSchedule(db).get(row.id) as ScheduleRow | undefined) ?? null
  );
}

/** The outcome of firing one due schedule (for the tick's logging). */
export type FireOutcome = "fired" | "skipped-queued" | "session-gone";

/**
 * Fire one due schedule: the per-row body of the server tick, extracted so it's
 * unit-testable (the terminal-side enqueue + queue check are INJECTED, so this
 * stays free of the prompt-queue import). The DB transition runs BEFORE the enqueue
 * so a DB failure can't leave the row "due" AND already delivered (which would
 * double-deliver next tick); a successful advance with a (near-impossible) enqueue
 * failure merely drops that one occurrence, matching the prompt queue's own
 * transience. A schedule whose target session is gone is disabled (a deleted
 * session never returns), so it stops churning the tick instead of enqueuing into a
 * dead session forever.
 *
 * Coalescing: if `isQueued` reports this schedule's prompt is STILL pending in the
 * target's queue (the session hasn't gone idle to drain it since the last fire), we
 * advance the cadence but DON'T enqueue a duplicate — otherwise a recurring schedule
 * against a busy/wedged session grows the queue unbounded and floods the agent with
 * stale copies the moment it recovers. The cadence still advances (so a one-shot
 * disables itself and a recurring schedule won't busy-retry every tick).
 */
export function fireSchedule(
  row: ScheduleRow,
  nowMs: number,
  enqueue: (sessionId: string, prompt: string) => void,
  isQueued?: (sessionId: string, prompt: string) => boolean
): FireOutcome {
  if (!(queries.getSession(db).get(row.session_id) as Session | undefined)) {
    setScheduleEnabled(row.id, false);
    return "session-gone";
  }
  const duplicate = isQueued?.(row.session_id, row.prompt) ?? false;
  recordScheduleFired(row, nowMs);
  if (duplicate) return "skipped-queued";
  enqueue(row.session_id, row.prompt);
  return "fired";
}
