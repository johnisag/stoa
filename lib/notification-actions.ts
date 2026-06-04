// MUST stay `import type` — session-status pulls in server-only backend code; a
// value import here would drag it into anything that uses this module.
import type { PushEventKind } from "./session-status";

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

const BUTTONS: Record<RespondAction, NotificationActionButton> = {
  approve: { action: "approve", title: "✅ Approve" },
  reject: { action: "reject", title: "✋ Reject" },
  stop: { action: "stop", title: "🛑 Stop" },
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
