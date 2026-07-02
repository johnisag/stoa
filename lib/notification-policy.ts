/**
 * Notification policy (#52) — the PURE decision core for closed-tab Web Push
 * DISPLAY: notification grouping, silent-vs-loud classification, quiet hours,
 * and per-session mute.
 *
 * Zero runtime imports (no DOM / SW / node), so both the service worker (which
 * applies these at show-time) and the unit tests can use it directly. The kind
 * type is duplicated here as a string union rather than imported from
 * lib/session-status (which pulls in server-only backend code) — the SW must be
 * able to `import` this module for a VALUE (not just a type).
 *
 * WHY the gate lives in the service worker: the server fans a push out to EVERY
 * device (it can't know which one is watching, or that device's local prefs), so
 * quiet-hours + per-session mute — both per-DEVICE settings — can only be applied
 * where the notification is actually shown: the SW. The SW can't read
 * localStorage, so the client mirrors these settings into IndexedDB
 * (lib/notification-policy-idb.ts) for the SW to read on each push.
 */

/** The push "kind" the server tags each notification with (rides in PushPayload). */
export type NotificationKind = "waiting" | "error" | "done";

/**
 * Quiet-hours window as minutes-since-midnight [0, 1440). `enabled` defaults OFF.
 * A window that wraps midnight (start > end, e.g. 22:00→07:00) is supported. A
 * start === end window is treated as "no quiet hours" (empty, not all-day) —
 * an all-day mute belongs to the master push toggle, not this control.
 */
export interface QuietHours {
  enabled: boolean;
  /** Minutes since local midnight the quiet window opens, [0, 1440). */
  startMin: number;
  /** Minutes since local midnight the quiet window closes, [0, 1440). */
  endMin: number;
}

/** The per-device notification policy the SW reads to gate a push's display. */
export interface NotificationPolicy {
  quietHours: QuietHours;
  /** Session ids the user has muted — a muted session shows no push. */
  mutedSessionIds: string[];
}

export const defaultQuietHours: QuietHours = {
  enabled: false,
  startMin: 22 * 60, // 22:00
  endMin: 7 * 60, // 07:00
};

export const defaultNotificationPolicy: NotificationPolicy = {
  quietHours: defaultQuietHours,
  mutedSessionIds: [],
};

/** A whole minute-of-day in [0, 1440), or null if the input isn't usable. */
function normalizeMinute(min: number): number | null {
  if (typeof min !== "number" || !Number.isFinite(min)) return null;
  const whole = Math.floor(min);
  if (whole < 0 || whole >= 1440) return null;
  return whole;
}

/**
 * Is `nowMin` (minutes-since-midnight) inside the quiet window? Correctly wraps
 * midnight: for a 22:00→07:00 window, 23:30 and 03:00 are inside, 12:00 is out.
 * Half-open [start, end): the exact end minute is NOT quiet (so a 07:00 alarm
 * fires). Disabled or an empty (start === end) / malformed window ⇒ never quiet.
 * Pure → unit-tested.
 */
export function isQuietTime(nowMin: number, quiet: QuietHours): boolean {
  if (!quiet || !quiet.enabled) return false;
  const now = normalizeMinute(nowMin);
  const start = normalizeMinute(quiet.startMin);
  const end = normalizeMinute(quiet.endMin);
  if (now === null || start === null || end === null) return false;
  if (start === end) return false; // empty window — no quiet hours
  if (start < end) {
    // Same-day window, e.g. 01:00→06:00.
    return now >= start && now < end;
  }
  // Wraps midnight, e.g. 22:00→07:00 — quiet is [start, 24:00) ∪ [0, end).
  return now >= start || now < end;
}

/**
 * The stable per-session grouping tag. Every push about a session carries the
 * SAME tag so the OS REPLACES the session's older notification with its newer
 * one instead of stacking a pile (the #52 grouping win). Namespaced so it can't
 * collide with the diagnostic "stoa-test" tag. Pure → unit-tested.
 */
export function notificationTag(sessionId: string): string {
  return `stoa-session-${sessionId}`;
}

/**
 * `renotify` re-alerts (sound/vibration/banner) when a notification REPLACES an
 * existing one sharing its tag — otherwise the OS silently swaps it. Only the
 * attention-worthy states (needs-you: waiting, error) should re-alert; a routine
 * completion replacing an older banner must stay quiet. Pure → unit-tested.
 * (Note: the platform requires a non-empty tag for renotify to be honored — the
 * stable per-session tag above satisfies that.)
 */
export function shouldRenotify(kind: NotificationKind): boolean {
  return kind === "waiting" || kind === "error";
}

/**
 * Low-priority completions are SILENT: a "done" push shows on screen but makes no
 * sound/vibration, while needs-you states (waiting/error) stay loud. Pure →
 * unit-tested. Mirrors the in-app default where "completed" pings are off by
 * default (lib/notifications.defaultSettings) — here they still SHOW (so the
 * grouped banner updates) but don't interrupt.
 */
export function isSilentKind(kind: NotificationKind): boolean {
  return kind === "done";
}

export interface NotifyDecisionInput {
  /** The push kind the server tagged; unknown/absent falls back to loud. */
  kind: NotificationKind | undefined;
  /** The session this push is about (for the mute check); absent ⇒ not muted. */
  sessionId: string | undefined;
  /** Local minutes-since-midnight at display time (from the SW's `new Date()`). */
  nowMin: number;
  policy: NotificationPolicy;
  /** A diagnostic test push always shows loud, bypassing quiet-hours + mute. */
  isTest?: boolean;
}

export interface NotifyDecision {
  /** Whether to show the notification at all. */
  show: boolean;
  /** When shown, whether it makes sound/vibration (false = silent banner). */
  silent: boolean;
  /** When shown, whether replacing a same-tag banner re-alerts. */
  renotify: boolean;
}

/**
 * The single DISPLAY decision the service worker applies to an incoming push:
 * mute + quiet-hours gate WHETHER it shows; kind decides silent-vs-loud and
 * renotify. Precedence (both fail-quiet):
 *   1. test push  → always show, loud (diagnostic; bypasses gates).
 *   2. muted session → suppress entirely (highest user intent).
 *   3. quiet hours → suppress the ping. (A muted session is already gone by 2.)
 *   4. otherwise → show; "done" is silent, needs-you is loud + renotify.
 * Pure → unit-tested; the SW passes real values straight in.
 */
export function decideNotify(input: NotifyDecisionInput): NotifyDecision {
  const kind = input.kind ?? "waiting"; // unknown kind ⇒ treat as loud/needs-you
  const loud = { show: true, silent: false, renotify: shouldRenotify(kind) };

  if (input.isTest) return loud;

  if (
    input.sessionId !== undefined &&
    input.policy.mutedSessionIds.includes(input.sessionId)
  ) {
    return { show: false, silent: true, renotify: false };
  }

  if (isQuietTime(input.nowMin, input.policy.quietHours)) {
    return { show: false, silent: true, renotify: false };
  }

  return {
    show: true,
    silent: isSilentKind(kind),
    renotify: shouldRenotify(kind),
  };
}

/** Minutes-since-local-midnight for a Date (the SW's clock). Pure helper. */
export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/** Toggle a session id in a muted-list, returning a NEW array (immutable). */
export function toggleMuted(mutedSessionIds: string[], id: string): string[] {
  return mutedSessionIds.includes(id)
    ? mutedSessionIds.filter((x) => x !== id)
    : [...mutedSessionIds, id];
}

/**
 * Parse an "HH:MM" 24-hour string to minutes-since-midnight, or null if it isn't
 * a valid time. Used by the settings UI's two time inputs. Pure → unit-tested.
 */
export function parseHhMm(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** Format minutes-since-midnight as a zero-padded "HH:MM" for a time input. */
export function formatHhMm(min: number): string {
  const norm = normalizeMinute(min) ?? 0;
  const h = Math.floor(norm / 60);
  const m = norm % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
