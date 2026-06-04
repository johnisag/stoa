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

/** Whether any session has a pending queue (keeps the ticker alive). */
export function hasAnyQueued(): boolean {
  return queues.size > 0;
}
