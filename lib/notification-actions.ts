// MUST stay `import type` — these pull in server-only backend code; a value
// import here would drag it into anything that uses this module (incl. the
// client-side per-card quick actions).
import type { PushEventKind } from "./session-status";
import type { SessionStatus } from "./status-detector";
import type { PromptKind } from "./auto-steer";

/**
 * Actionable notifications + per-card quick action: the button set a notification
 * carries and how it maps to a terminal operation. Pure (no DOM/SW/backend) so the
 * decision logic is unit-testable — the service worker renders `actionsForKind(...)`
 * and `/api/sessions/[id]/respond` runs `applyResponse(...)`.
 *
 * Mostly ATTENTION-ONLY: a notification's job is to tell you a session is READY or NEEDS
 * INPUT so you swap to it. The old approve/reject keystroke buttons were noisy because
 * they fired on mere turn-ends and drove the agent BLINDLY (Enter when "No" is highlighted
 * doesn't approve). Two actions survive that critique:
 *   stop    → kill        (authoritative for any agent/state)
 *   approve → send Enter   (#9 — ONLY offered for a press-Enter-to-continue / [Y/n] proceed
 *                           prompt (`continue`). NOT a permission MENU's single-shot "Yes"
 *                           (`affirmative`): a lock-screen Approve is BLIND (the toast can't
 *                           show the gated command) and ships to users who did NOT opt into
 *                           unattended keystrokes, so it must hold to the STRUCTURALLY benign
 *                           shape — a denylist guarding an arbitrary command is fail-OPEN and
 *                           must never back a one-tap grant. (Auto-answer DOES press Enter for
 *                           `affirmative`, but only behind the explicit STOA_AUTO_ANSWER opt-in.)
 *                           Never for blanket / negative / destructive / freeform. detectPushEvents
 *                           maps a turn-end to "done", so "waiting" is a REAL prompt, and the
 *                           /respond route RE-VERIFIES the live prompt before pressing Enter
 *                           (push→tap TOCTOU). The whole Approve affordance is OPT-IN
 *                           (STOA_PUSH_APPROVE=1, OFF by default — see pushApproveEnabled),
 *                           enforced at the push-build AND the route; default-off keeps
 *                           notifications purely attention-only. One-tap approve is deliberate,
 *                           re-checked, opt-in, and narrow — not the old blind keystroke.
 * The "ready vs needs input" distinction also lives in the notification COPY
 * (hooks/useNotifications.ts + detectPushEvents, keyed on `hasPrompt`).
 */

/** A notification action button (subset of the web NotificationAction shape). */
export interface NotificationActionButton {
  action: string;
  title: string;
}

export const RESPOND_ACTIONS = ["stop", "approve"] as const;
export type RespondAction = (typeof RESPOND_ACTIONS)[number];

export function isRespondAction(s: unknown): s is RespondAction {
  return (
    typeof s === "string" && (RESPOND_ACTIONS as readonly string[]).includes(s)
  );
}

// Plain ASCII labels — emoji in Web Notification action buttons render as tofu
// boxes / vertical bars on Windows (the Action Center toast), not the glyph.
const BUTTONS: Record<RespondAction, NotificationActionButton> = {
  stop: { action: "stop", title: "Stop" },
  approve: { action: "approve", title: "Approve" },
};

/**
 * A prompt is one-tap APPROVABLE from a notification only for a press-Enter-to-continue /
 * [Y/n] proceed prompt (`continue`) — the structurally benign shape where Enter just lets the
 * agent keep going. A permission MENU's single-shot "Yes" (`affirmative`) is deliberately NOT
 * approvable here: it gates an arbitrary command whose only danger filter is a non-exhaustive
 * denylist (fail-OPEN), and a lock-screen tap is BLIND (no command shown) reaching users who
 * never opted into unattended keystrokes — so fail-closed it stays attention-only (swap to the
 * app). Auto-answer (nextAutoAnswerAction) DOES Enter `affirmative`, but only behind the explicit
 * STOA_AUTO_ANSWER opt-in; this is intentionally a STRICT SUBSET of that. blanket / negative /
 * destructive / freeform: never. This is the PURE prompt-kind predicate; the Approve button is
 * ADDITIONALLY gated by the STOA_PUSH_APPROVE opt-in at the call sites (server push-build + the
 * /respond route), so by default no Approve is offered at all. Pure → unit-tested.
 */
export function canApproveFromPrompt(
  kind: PromptKind | null | undefined
): boolean {
  return kind === "continue";
}

/**
 * Which buttons a push of this kind carries. A live session (waiting at a prompt OR
 * errored) is worth a one-tap Stop from the lock screen; a waiting session at a SAFE
 * single-shot prompt (canApprove) also gets a one-tap Approve. Tapping the body opens the
 * app to swap to it; a "done" session has nothing left to act on.
 */
export function actionsForKind(
  kind: PushEventKind,
  opts?: { canApprove?: boolean }
): NotificationActionButton[] {
  switch (kind) {
    case "waiting":
      return opts?.canApprove
        ? [BUTTONS.approve, BUTTONS.stop]
        : [BUTTONS.stop];
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
export type ResponseOp = "kill" | "enter";

export function planResponse(action: RespondAction): ResponseOp {
  switch (action) {
    case "stop":
      return "kill";
    case "approve":
      return "enter"; // press Enter → proceeds a press-Enter-to-continue / [Y/n] prompt
  }
}

/**
 * What applyResponse needs from a backend — a structural subset of
 * SessionBackend, so this module stays free of any backend import and the
 * action→op→call dispatch is unit-testable with a plain spy.
 */
export interface ResponseTarget {
  kill(name: string): Promise<void>;
  sendEnter(name: string): Promise<void>;
}

/** Route an action to the matching terminal op on `target` for session `name`. The route
 *  has already RE-VERIFIED a live approvable prompt before calling this for "approve". */
export function applyResponse(
  target: ResponseTarget,
  name: string,
  action: RespondAction
): Promise<void> {
  switch (planResponse(action)) {
    case "kill":
      return target.kill(name);
    case "enter":
      return target.sendEnter(name);
  }
}
