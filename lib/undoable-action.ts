/**
 * Delay+cancel wrapper for destructive actions (roadmap #37). Where a true undo
 * is impossible (deleting a session tears down a live pty + worktree), the
 * pattern is delay-then-execute: the destructive call does NOT run for a grace
 * window while a sonner "Undo" toast shows; Undo cancels it, the timeout
 * executes it. Pure and client-side (plain setTimeout — no unref, no node
 * builtins); the toast + optimistic-hide wiring lives at the call sites, which
 * create one runner per concern at MODULE scope so pending timers survive
 * re-renders and unmounts.
 */

/** Grace window before a scheduled destructive action runs (and the matching
 * toast duration, so the Undo button disappears when it stops working). */
export const UNDO_DELAY_MS = 5000;

export interface UndoableRunner {
  /**
   * Queue `execute` to run after the grace window. If the same id already has
   * a pending action, the predecessor is flushed (run immediately) first — a
   * replaced schedule must never lose its delete. `onScheduled` fires once the
   * timer is armed (the hook for the caller's optimistic hide).
   */
  schedule(id: string, execute: () => void, onScheduled?: () => void): void;
  /** Drop a pending action without running it. Unknown/settled ids are a no-op. */
  cancel(id: string): void;
  /** Run a pending action NOW and clear its timer. Unknown/settled ids are a no-op. */
  flush(id: string): void;
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
    pending() {
      return [...entries.keys()];
    },
  };
}
