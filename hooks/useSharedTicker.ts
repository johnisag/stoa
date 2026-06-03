"use client";

import { useSyncExternalStore } from "react";

/**
 * One module-level 30s ticker shared by every subscriber, instead of N separate
 * setIntervals (e.g. one per SessionCard's relative timestamp — which, with a
 * fleet of sessions, was N timers firing on their own offsets and undercutting
 * the SessionCard memo). The store value is just an incrementing tick; via
 * useSyncExternalStore each subscriber re-renders on the tick even under a
 * memoized parent. The interval is created on the first subscriber and cleared
 * when the last one unsubscribes.
 */
let tick = 0;
const listeners = new Set<() => void>();
let interval: ReturnType<typeof setInterval> | null = null;

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (interval === null) {
    interval = setInterval(() => {
      tick++;
      for (const l of listeners) l();
    }, 30000);
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && interval !== null) {
      clearInterval(interval);
      interval = null;
    }
  };
}

const getSnapshot = () => tick;
const getServerSnapshot = () => 0;

/** Re-render the caller roughly every 30s off ONE shared interval. */
export function useTick30s(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
