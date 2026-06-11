/**
 * Recurrence for scheduled LOCAL tasks (#7 cron). A recurring scheduled task
 * re-arms itself: when the reconciler promotes it to pending, it also schedules
 * the NEXT future occurrence (a fresh scheduled clone). Pure + testable — the
 * reconciler owns the DB side. Recurrence is local-only (a recurring GitHub issue
 * makes no sense); the create route enforces that.
 */

// "once" is the UI's no-recurrence sentinel (Radix Select forbids an empty value);
// it normalizes to null. The rest map to a fixed interval.
export const RECURRENCE_OPTIONS = [
  { value: "once", label: "Once" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
] as const;

/** A recurrence picker value, including the "once" (no-repeat) sentinel. */
export type Recurrence = (typeof RECURRENCE_OPTIONS)[number]["value"];

const INTERVAL_MS: Record<string, number> = {
  hourly: 3_600_000,
  daily: 86_400_000,
  weekly: 604_800_000,
};

/** A valid recurring keyword, or null (one-shot) for "once"/unknown/empty.
 * Uses Object.hasOwn (NOT `in`) so inherited Object.prototype keys like
 * "toString"/"constructor" can't sneak through and break nextOccurrence. */
export function normalizeRecurrence(value: unknown): string | null {
  return typeof value === "string" && Object.hasOwn(INTERVAL_MS, value)
    ? value
    : null;
}

/**
 * The next occurrence strictly AFTER `nowMs`, advancing from `fromIso` by the
 * recurrence interval. Missed occurrences (after downtime) are skipped in ONE
 * jump so a long outage can't cause a catch-up storm. Returns null for a non-
 * recurring/unknown value. Interval is milliseconds, so a daily task can drift up
 * to an hour across a DST change — acceptable for v1.
 */
export function nextOccurrence(
  recurrence: string | null,
  fromIso: string | null,
  nowMs: number
): string | null {
  // Bracket access traverses the prototype chain, so a value like "toString"
  // would read an inherited function. Require an actual number (defense in depth
  // — recurrence round-trips through the DB and could be any string).
  const interval = recurrence ? INTERVAL_MS[recurrence] : undefined;
  if (typeof interval !== "number") return null;
  const parsed = fromIso ? Date.parse(fromIso) : NaN;
  const base = Number.isNaN(parsed) ? nowMs : parsed;
  let next = base + interval;
  if (next <= nowMs) {
    const missed = Math.floor((nowMs - base) / interval);
    next = base + (missed + 1) * interval;
  }
  // A near-max-date anchor can push `next` past the ECMAScript date range, where
  // toISOString() throws RangeError — which, unguarded inside the reconciler tick,
  // would halt the whole fleet. Fail closed to null (this repo's corrupt-Date class).
  const at = new Date(next);
  if (Number.isNaN(at.getTime())) return null;
  return at.toISOString();
}

/**
 * Is a cadence-driven job due to run at `nowMs`? True when a cadence is armed AND
 * either it has never run (`lastIso` null → first run), its anchor is corrupt
 * (re-run and re-stamp), or at least one full interval has elapsed since `lastIso`.
 * Pure — the maintainer pass uses this for its survey cadence. Reuses
 * nextOccurrence (with the anchor as `nowMs`, so the result is anchor+interval).
 */
export function isRecurrenceDue(
  recurrence: string | null,
  lastIso: string | null,
  nowMs: number
): boolean {
  if (!normalizeRecurrence(recurrence)) return false;
  if (!lastIso) return true;
  const lastMs = Date.parse(lastIso);
  if (Number.isNaN(lastMs)) return true; // corrupt anchor → run now, re-stamp
  const next = nextOccurrence(recurrence, lastIso, lastMs);
  return next !== null && Date.parse(next) <= nowMs;
}

/** Short human label for the scheduled list, e.g. "repeats daily" (null if once). */
export function recurrenceLabel(recurrence: string | null): string | null {
  const opt = recurrence
    ? RECURRENCE_OPTIONS.find((o) => o.value === recurrence)
    : undefined;
  return opt && opt.value !== "once"
    ? `repeats ${opt.label.toLowerCase()}`
    : null;
}
