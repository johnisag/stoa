// MUST stay `import type` — these pull in server-only backend code; a value
// import here would drag it into anything that uses this module (incl. the
// client-side per-card quick actions).
import type { PushEventKind } from "./session-status";
import type { SessionStatus } from "./status-detector";

/**
 * Actionable Web Push: the button set a notification carries, and how each
 * button maps to a terminal operation. Pure (no DOM/SW/backend) so the whole
 * loop's decision logic is unit-testable — the service worker renders
 * `actionsForKind(...)`, and `/api/sessions/[id]/respond` runs `planResponse(...)`.
 *
 * The actions are best-effort conveniences for the common case (a Claude
 * permission prompt: a select menu with the safe one-time "Yes" highlighted):
 *   approve → Enter   (accept the highlighted/default option)
 *   reject  → Escape  (cancel the prompt)
 *   stop    → kill     (authoritative — always correct, any agent/state)
 */

/** A notification action button (subset of the web NotificationAction shape). */
export interface NotificationActionButton {
  action: string;
  title: string;
}

export const RESPOND_ACTIONS = ["approve", "reject", "stop"] as const;
export type RespondAction = (typeof RESPOND_ACTIONS)[number];

export function isRespondAction(s: unknown): s is RespondAction {
  return (
    typeof s === "string" && (RESPOND_ACTIONS as readonly string[]).includes(s)
  );
}

// Plain ASCII labels — emoji in Web Notification action buttons render as tofu
// boxes / vertical bars on Windows (the Action Center toast), not the glyph.
const BUTTONS: Record<RespondAction, NotificationActionButton> = {
  approve: { action: "approve", title: "Approve" },
  reject: { action: "reject", title: "Reject" },
  stop: { action: "stop", title: "Stop" },
};

/**
 * Which buttons a push of this kind carries. A "waiting" session is at a prompt
 * → offer the full decision (approve/reject) plus stop; an "error" session is
 * only worth stopping; a "done" session has nothing left to act on.
 */
export function actionsForKind(
  kind: PushEventKind
): NotificationActionButton[] {
  switch (kind) {
    case "waiting":
      return [BUTTONS.approve, BUTTONS.reject, BUTTONS.stop];
    case "error":
      return [BUTTONS.stop];
    case "done":
      return [];
  }
}

/**
 * The same respond actions surfaced as in-app per-card quick buttons, driven by
 * the session's live status: a waiting session gets the full decision, a running
 * or errored one just gets stop, and idle/dead have nothing to act on. Mirrors
 * actionsForKind (push) so the board and the lock screen offer the same choices.
 */
export function cardActionsForStatus(status: SessionStatus): RespondAction[] {
  switch (status) {
    case "waiting":
      return ["approve", "reject", "stop"];
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
 * benign. 404/409 mean the session is already gone or has moved past the prompt
 * — the desired end state for stop/approve/reject, and it absorbs a double-tap
 * (the second request 409s) so a successful action never shows an error.
 */
export function respondErrorMessage(status: number): string | null {
  if (status === 404 || status === 409) return null;
  return `request failed (${status})`;
}

/** The terminal operation an action resolves to (backend-agnostic). */
export type ResponseOp = "enter" | "escape" | "kill";

export function planResponse(action: RespondAction): ResponseOp {
  switch (action) {
    case "approve":
      return "enter";
    case "reject":
      return "escape";
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
  sendEnter(name: string): Promise<void>;
  sendEscape(name: string): Promise<void>;
  kill(name: string): Promise<void>;
}

/** Route an action to the matching terminal op on `target` for session `name`. */
export function applyResponse(
  target: ResponseTarget,
  name: string,
  action: RespondAction
): Promise<void> {
  switch (planResponse(action)) {
    case "enter":
      return target.sendEnter(name);
    case "escape":
      return target.sendEscape(name);
    case "kill":
      return target.kill(name);
  }
}
