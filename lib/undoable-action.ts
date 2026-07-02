/**
 * Delay+cancel wrapper for destructive actions (roadmap #37). Where a true undo
 * is impossible (deleting a session tears down a live pty + worktree), the
 * pattern is delay-then-execute: the destructive call does NOT run for a grace
 * window while a sonner "Undo" toast shows; Undo cancels it, the timeout
 * executes it. Client-side (plain setTimeout — no unref, no node builtins);
 * the toast + optimistic-hide wiring lives at the call sites, which create one
 * runner per concern at MODULE scope so pending timers survive re-renders and
 * unmounts.
 *
 * Semantics worth stating out loud:
 *  - DISMISSING the toast (the X) neither cancels nor confirms — the window
 *    still runs out and the action executes. Only the Undo button cancels.
 *    (The item was optimistically hidden at schedule time, so nothing visibly
 *    changes when the timer later fires.)
 *  - An Undo click that races the timer (clicked in the same instant the
 *    window elapses) is a no-op: cancel() of an executed id does nothing and
 *    the action stands. The toast duration equals the window so the button
 *    disappears when it stops working.
 *  - Page unload (tab close / reload — SPA navigation never unloads) FLUSHES
 *    every pending action best-effort via pagehide/beforeunload, so a delete
 *    the user watched happen can't silently resurrect on the next visit.
 */

/** Grace window before a scheduled destructive action runs (and the matching
 * toast duration, so the Undo button disappears when it stops working). */
export const UNDO_DELAY_MS = 5000;

export interface UndoableRunner {
  /**
   * Queue `execute` to run after the grace window. If the same id already has
   * a pending action, the predecessor is flushed (run immediately) first — a
   * replaced schedule must never lose its delete. `onScheduled` fires once the
   * timer is armed (the hook for the caller's optimistic hide). Callers
   * double-firing the SAME logical action should guard with pending() instead
   * of rescheduling (a reschedule executes the first delete immediately, and
   * its twin will later fail against the already-deleted resource).
   */
  schedule(id: string, execute: () => void, onScheduled?: () => void): void;
  /** Drop a pending action without running it. Unknown/settled ids are a no-op. */
  cancel(id: string): void;
  /** Run a pending action NOW and clear its timer. Unknown/settled ids are a no-op. */
  flush(id: string): void;
  /** Run EVERY pending action now (the unload path). */
  flushAll(): void;
  /** Ids still pending (scheduled, not yet executed or cancelled). */
  pending(): string[];
}

export function createUndoableRunner({
  delayMs,
}: {
  delayMs: number;
}): UndoableRunner {
  const entries = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; execute: () => void }
  >();

  // Shared by flush + timeout: remove the entry BEFORE executing so a throwing
  // execute still settles the id (execute-at-most-once, idempotent thereafter).
  const flush = (id: string) => {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    clearTimeout(entry.timer);
    entry.execute();
  };

  const flushAll = () => {
    for (const id of [...entries.keys()]) flush(id);
  };

  // A pending delete must survive the PAGE dying, not just the component: the
  // item already vanished from the UI, so losing the timer would silently
  // resurrect it on the next load. pagehide is the reliable signal on mobile
  // Safari; beforeunload is the desktop belt. Best-effort — an in-flight
  // fetch at unload may still be cut short by the browser, which is as good
  // as a client-only implementation can make this.
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushAll);
    window.addEventListener("beforeunload", flushAll);
  }

  return {
    schedule(id, execute, onScheduled) {
      flush(id);
      const timer = setTimeout(() => flush(id), delayMs);
      entries.set(id, { timer, execute });
      onScheduled?.();
    },
    cancel(id) {
      const entry = entries.get(id);
      if (!entry) return;
      entries.delete(id);
      clearTimeout(entry.timer);
    },
    flush,
    flushAll,
    pending() {
      return [...entries.keys()];
    },
  };
}
