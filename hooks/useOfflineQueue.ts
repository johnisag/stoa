"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  drainQueue,
  type OfflineAction,
  type OfflineQueueStore,
} from "@/lib/offline-queue";
import { createOfflineQueueStore } from "@/lib/offline-queue-idb";

/**
 * Client glue for the offline command queue (#12). The durable store + replay
 * engine live in lib/; this wires them to the browser: a lazy singleton store, an
 * enqueue helper, and a drain hook that replays on reconnect with toast feedback.
 */

// One store per tab. Created lazily so module eval never touches IndexedDB (SSR /
// import-time safe); the first enqueue or drain materializes it.
let _store: OfflineQueueStore | null = null;
function store(): OfflineQueueStore {
  if (!_store) _store = createOfflineQueueStore();
  return _store;
}

// Re-entrancy guard: mount + a near-simultaneous `online` event (or two `online`
// events) must not drain concurrently — both would `getAll()` before either
// `remove()`s and replay the same action twice. Server idempotency would still
// dedupe it, but the redundant request + double-counted toast are avoidable.
let draining = false;

/** A unique id for a queued action — also the server idempotency key. */
export function newActionId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `act-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Monotonic per-tab enqueue counter — the OfflineAction.seq tiebreaker that keeps
// two same-millisecond sends in send order on replay (createdAt alone can tie).
let _seq = 0;
export function nextSeq(): number {
  return ++_seq;
}

/** Persist a mutating action to replay on the next reconnect. */
export function enqueueOfflineAction(action: OfflineAction): Promise<void> {
  return store().put(action);
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * Mount ONCE (app root). Replays the queued offline actions when the tab regains
 * connectivity — and once on mount, to flush a backlog left by a previous session.
 * Summarizes the pass as a toast and refreshes the queue views that just changed.
 */
export function useOfflineQueueDrain(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;

    const drain = async () => {
      // Skip if we know we're offline — the `online` event will call us back.
      if (typeof navigator !== "undefined" && navigator.onLine === false)
        return;
      if (draining) return; // a pass is already in flight (see `draining` above)
      draining = true;
      let result;
      try {
        result = await drainQueue(store(), fetch);
      } catch {
        return; // a store failure must never break the app
      } finally {
        draining = false;
      }
      if (cancelled) return;
      if (result.sent > 0) {
        toast.success(`Sent ${plural(result.sent, "queued action")}`);
        // A replayed prompt-enqueue landed server-side — refresh the queue views.
        queryClient.invalidateQueries({ queryKey: ["session-queue"] });
      }
      if (result.dropped > 0) {
        toast.error(`Dropped ${plural(result.dropped, "stale queued action")}`);
      }
    };

    void drain(); // flush any backlog now
    const onOnline = () => void drain();
    window.addEventListener("online", onOnline);
    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
    };
  }, [queryClient]);
}
