/**
 * Offline command queue + reconnect replay (#12).
 *
 * Stoa is mobile-first and phones drop connections constantly. When a MUTATING
 * request (today: queueing a prompt to a session) can't reach the server, instead
 * of failing we stash it in a durable client-side queue and replay it the moment
 * connectivity returns — so a "send to my agent" tapped in a dead spot still lands.
 *
 * This module is the PORTABLE core: a pure replay POLICY (classify an attempt as
 * success / drop / retry) + a small replay ENGINE over an injected store + fetch.
 * Keeping the store + fetch injectable makes the engine exhaustively unit-testable
 * in Node (no IndexedDB, no browser) — the browser IndexedDB store lives in
 * lib/offline-queue-idb.ts and the React wiring in hooks/useOfflineQueue.ts.
 *
 * Why page-driven replay (the `online` event) rather than a Service-Worker
 * Background-Sync tag like amux: Background Sync is Chromium-only and absent on
 * iOS Safari — the platform a mobile-first tool most needs offline resilience on.
 * Draining from the page on reconnect works everywhere; SW Background Sync is a
 * deferred progressive enhancement.
 */

/** A queued mutating request awaiting replay. `id` is also the idempotency key the
 *  server dedupes on, so replaying the same action twice enqueues it once. */
export interface OfflineAction {
  id: string;
  url: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  /** Pre-serialized JSON request body (the id is embedded so the server dedupes). */
  body: string;
  /** Human label for the toast feedback (e.g. the session name). */
  label: string;
  createdAt: number;
  /** Monotonic per-session enqueue counter — breaks `createdAt` ties so two sends
   *  in the SAME millisecond still replay in send order (IndexedDB's getAll returns
   *  key/UUID order, which would otherwise scramble same-ms sends). */
  seq: number;
  attempts: number;
}

/**
 * A replayable URL must be a same-origin, root-relative path ("/api/…"). The queue
 * persists in IndexedDB, which any in-origin script (or a corrupted entry) can
 * write; refusing absolute/protocol-relative URLs means a tampered action can never
 * make the replay engine fetch a cross-origin target. Pure.
 */
export function isReplayableUrl(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//");
}

/** Give up on an action after this many failed replay attempts (then drop it). */
export const OFFLINE_QUEUE_MAX_ATTEMPTS = 5;

/** The outcome of one replay attempt: an HTTP response, or a thrown fetch. */
export type ReplayOutcome =
  { ok: boolean; status: number } | { networkError: true };

export type ReplayDecision = "success" | "drop" | "retry";

function isNetworkError(o: ReplayOutcome): o is { networkError: true } {
  return "networkError" in o;
}

/**
 * Classify a replay attempt. Pure.
 * - 2xx → success (remove from the queue).
 * - A network error → retry (we're likely still offline / it was transient).
 * - 408 / 429 / 5xx → retry (timeout, rate-limit, server-side — may succeed later).
 * - Any other 4xx → drop: a malformed / unauthorized / not-found request won't
 *   start succeeding on replay, so retrying it forever is pointless (amux's
 *   "drop stale 4xx" rule).
 */
export function classifyReplay(outcome: ReplayOutcome): ReplayDecision {
  if (isNetworkError(outcome)) return "retry";
  if (outcome.ok) return "success";
  const s = outcome.status;
  if (s === 408 || s === 429 || s >= 500) return "retry";
  return "drop";
}

/** Has this action used up its retry budget? Pure. */
export function exhausted(action: OfflineAction): boolean {
  return action.attempts >= OFFLINE_QUEUE_MAX_ATTEMPTS;
}

/** Durable storage for the queue. The browser impl is IndexedDB-backed; tests use
 *  an in-memory one. Implementations preserve insertion via the action's id. */
export interface OfflineQueueStore {
  getAll(): Promise<OfflineAction[]>;
  put(action: OfflineAction): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Tally of a drain pass, for the summary toast. */
export interface DrainResult {
  sent: number;
  dropped: number;
  /** Actions kept for a later attempt (bumped, not exhausted). */
  retried: number;
}

/**
 * Replay every queued action oldest-first through `fetchImpl`. Pure orchestration
 * over the injected store + fetch (→ Node-testable). On each action:
 * - success / drop → remove it.
 * - retry → bump `attempts`; if that exhausts the budget, drop it; otherwise keep
 *   it. On a NETWORK error we stop the whole pass early (we're still offline, so
 *   hammering the rest is wasteful — the next reconnect drains them).
 * `onResult` fires per action for toast/telemetry. Never throws.
 */
export async function drainQueue(
  store: OfflineQueueStore,
  fetchImpl: typeof fetch,
  onResult?: (action: OfflineAction, decision: ReplayDecision) => void
): Promise<DrainResult> {
  const actions = (await store.getAll()).sort(
    (a, b) => a.createdAt - b.createdAt || a.seq - b.seq
  );
  const result: DrainResult = { sent: 0, dropped: 0, retried: 0 };

  for (const action of actions) {
    // Refuse a tampered/corrupted entry that points off-origin — drop it.
    if (!isReplayableUrl(action.url)) {
      try {
        await store.remove(action.id);
      } catch {
        /* leave it; it's inert (never fetched) */
      }
      result.dropped++;
      onResult?.(action, "drop");
      continue;
    }
    let outcome: ReplayOutcome;
    try {
      const res = await fetchImpl(action.url, {
        method: action.method,
        headers: { "Content-Type": "application/json" },
        body: action.body,
      });
      outcome = { ok: res.ok, status: res.status };
    } catch {
      outcome = { networkError: true };
    }

    const decision = classifyReplay(outcome);
    // Isolate each action's store ops: a failed remove/put (e.g. an IndexedDB
    // QuotaExceeded / aborted transaction) must leave that action queued and let
    // the pass continue — never reject the whole drain (the "never throws" above).
    try {
      if (decision === "success") {
        await store.remove(action.id);
        result.sent++;
        onResult?.(action, "success");
      } else if (decision === "drop") {
        await store.remove(action.id);
        result.dropped++;
        onResult?.(action, "drop");
      } else {
        const bumped = { ...action, attempts: action.attempts + 1 };
        if (exhausted(bumped)) {
          await store.remove(action.id);
          result.dropped++;
          onResult?.(action, "drop");
        } else {
          await store.put(bumped);
          result.retried++;
          onResult?.(action, "retry");
        }
      }
    } catch {
      // store op failed — leave the action queued, count nothing, keep going.
    }
    // Still offline: stop draining; the next reconnect picks up the rest.
    if (decision === "retry" && isNetworkError(outcome)) break;
  }
  return result;
}

/** In-memory store — used by tests, and as the fallback when IndexedDB is
 *  unavailable (Safari private mode, locked-down WebViews) so queueing still works
 *  within the session even if it can't survive a reload. Insertion-ordered. */
export class MemoryOfflineQueueStore implements OfflineQueueStore {
  private map = new Map<string, OfflineAction>();

  async getAll(): Promise<OfflineAction[]> {
    return [...this.map.values()];
  }
  async put(action: OfflineAction): Promise<void> {
    this.map.set(action.id, action);
  }
  async remove(id: string): Promise<void> {
    this.map.delete(id);
  }
}
