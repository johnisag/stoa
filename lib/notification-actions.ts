// MUST stay `import type` — these pull in server-only backend code; a value
// import here would drag it into anything that uses this module (incl. the
// client-side per-card quick actions).
import type { PushEventKind } from "./session-status";
import type { SessionStatus } from "./status-detector";

/**
 * Actionable notifications + per-card quick action: the button set a notification
 * carries and how it maps to a terminal operation. Pure (no DOM/SW/backend) so the
 * decision logic is unit-testable — the service worker renders `actionsForKind(...)`
 * and `/api/sessions/[id]/respond` runs `applyResponse(...)`.
 *
 * ATTENTION-ONLY model: the job of a notification is to tell you a session is READY
 * or NEEDS INPUT so you swap to it — NOT to drive the agent remotely. The old
 * approve (Enter) / reject (Escape) keystroke buttons were noisy and fired on mere
 * turn-ends; they're gone. The one action that's ALWAYS correct survives:
 *   stop → kill   (authoritative for any agent/state)
 * The "ready vs needs input" distinction lives in the notification COPY
 * (hooks/useNotifications.ts + detectPushEvents, keyed on `hasPrompt`), and
 * `hasPrompt` still flows for the auto-steer harness — only the buttons changed.
 */

/** A notification action button (subset of the web NotificationAction shape). */
export interface NotificationActionButton {
  action: string;
  title: string;
}

export const RESPOND_ACTIONS = ["stop"] as const;
export type RespondAction = (typeof RESPOND_ACTIONS)[number];

export function isRespondAction(s: unknown): s is RespondAction {
  return (
    typeof s === "string" && (RESPOND_ACTIONS as readonly string[]).includes(s)
  );
}

// Plain ASCII label — emoji in Web Notification action buttons render as tofu
// boxes / vertical bars on Windows (the Action Center toast), not the glyph.
const BUTTONS: Record<RespondAction, NotificationActionButton> = {
  stop: { action: "stop", title: "Stop" },
};

/**
 * Which buttons a push of this kind carries. A live session (waiting at a prompt
 * OR errored) is worth a one-tap Stop from the lock screen; tapping the body opens
 * the app to swap to it. A "done" session has nothing left to act on.
 */
export function actionsForKind(
  kind: PushEventKind
): NotificationActionButton[] {
  switch (kind) {
    case "waiting":
    case "error":
      return [BUTTONS.stop];
    case "done":
      return [];
  }
}

/**
 * The respond action surfaced as an in-app per-card quick button, driven by the
 * session's live status: a session whose agent is alive (running, errored, or
 * waiting) gets a one-tap Stop; an idle/dead session has nothing to act on. (No
 * approve/reject — you swap to the session and type, the terminal is the source of
 * truth; the notification already told you it's ready / needs input.)
 */
export function cardActionsForStatus(status: SessionStatus): RespondAction[] {
  switch (status) {
    case "waiting":
    case "running":
    case "error":
      return ["stop"];
    case "idle":
    case "dead":
      return [];
  }
}

/**
 * Map a failed /respond HTTP status to a user message, or null if the failure is
 * benign. 404/409 mean the session is already gone or no longer running — the
 * desired end state for stop, and it absorbs a double-tap (the second request
 * 409s) so a successful action never shows an error.
 */
export function respondErrorMessage(status: number): string | null {
  if (status === 404 || status === 409) return null;
  return `request failed (${status})`;
}

/** The terminal operation an action resolves to (backend-agnostic). */
export type ResponseOp = "kill";

export function planResponse(action: RespondAction): ResponseOp {
  switch (action) {
    case "stop":
      return "kill";
  }
}

/**
 * What applyResponse needs from a backend — a structural subset of
 * SessionBackend, so this module stays free of any backend import and the
 * action→op→call dispatch is unit-testable with a plain spy.
 */
export interface ResponseTarget {
  kill(name: string): Promise<void>;
}

/** Route an action to the matching terminal op on `target` for session `name`. */
export function applyResponse(
  target: ResponseTarget,
  name: string,
  action: RespondAction
): Promise<void> {
  switch (planResponse(action)) {
    case "kill":
      return target.kill(name);
  }
}
