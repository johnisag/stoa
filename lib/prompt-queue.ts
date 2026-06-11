/**
 * In-memory per-session prompt queue. Lives in the server process and is shared
 * by the Next API routes and the status ticker (same process). Type the next
 * tasks while an agent works; the ticker dispatches them one at a time as the
 * session goes idle. Queues are transient by design — drained quickly as the
 * agent settles — so they're not persisted across a server restart.
 */

const queues = new Map<string, string[]>();

/** Append a prompt to a session's queue; returns the updated queue. */
export function enqueuePrompt(sessionId: string, text: string): string[] {
  const q = queues.get(sessionId) ?? [];
  q.push(text);
  queues.set(sessionId, q);
  return [...q];
}

/** The session's queued prompts (a copy), in dispatch order. */
export function listQueue(sessionId: string): string[] {
  return [...(queues.get(sessionId) ?? [])];
}

/** The next prompt without removing it, or null if the queue is empty. */
export function peekPrompt(sessionId: string): string | null {
  return queues.get(sessionId)?.[0] ?? null;
}

/** Remove + return the next prompt, or null if empty. Prunes empty queues. */
export function dequeuePrompt(sessionId: string): string | null {
  const q = queues.get(sessionId);
  if (!q || q.length === 0) return null;
  const next = q.shift() ?? null;
  if (q.length === 0) queues.delete(sessionId);
  return next;
}

/** Drop a session's whole queue. */
export function clearQueue(sessionId: string): void {
  queues.delete(sessionId);
}

// The ticker dispatches item 0 whenever the agent goes idle, so a client view can
// be stale by the time the user taps. `expectedText` (the item the client THOUGHT
// was at `index`) makes each op address by (index, text): if the queue shifted and
// the text no longer matches, the op is a no-op — never mutating the wrong prompt.
function mismatched(
  q: string[],
  index: number,
  expectedText?: string
): boolean {
  return expectedText !== undefined && q[index] !== expectedText;
}

/**
 * Remove the item at `index`; returns the updated queue. Out-of-range indices
 * are a no-op. Prunes the queue when it empties. No-ops if `expectedText` is given
 * and doesn't match the item at `index` (the queue raced).
 */
export function removeAt(
  sessionId: string,
  index: number,
  expectedText?: string
): string[] {
  const q = queues.get(sessionId);
  if (!q || index < 0 || index >= q.length) return [...(q ?? [])];
  if (mismatched(q, index, expectedText)) return [...q];
  q.splice(index, 1);
  if (q.length === 0) queues.delete(sessionId);
  return [...q];
}

/**
 * Swap the item at `index` with the one before it (move it earlier in dispatch
 * order); returns the updated queue. A no-op for the first item, a bad index, or
 * an `expectedText` mismatch (the queue raced).
 */
export function moveUp(
  sessionId: string,
  index: number,
  expectedText?: string
): string[] {
  const q = queues.get(sessionId);
  if (!q || index <= 0 || index >= q.length) return [...(q ?? [])];
  if (mismatched(q, index, expectedText)) return [...q];
  [q[index - 1], q[index]] = [q[index], q[index - 1]];
  return [...q];
}

/**
 * Swap the item at `index` with the one after it (move it later in dispatch
 * order); returns the updated queue. A no-op for the last item, a bad index, or
 * an `expectedText` mismatch (the queue raced).
 */
export function moveDown(
  sessionId: string,
  index: number,
  expectedText?: string
): string[] {
  const q = queues.get(sessionId);
  if (!q || index < 0 || index >= q.length - 1) return [...(q ?? [])];
  if (mismatched(q, index, expectedText)) return [...q];
  [q[index], q[index + 1]] = [q[index + 1], q[index]];
  return [...q];
}

/** Whether any session has a pending queue (keeps the ticker alive). */
export function hasAnyQueued(): boolean {
  return queues.size > 0;
}
