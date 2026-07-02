"use client";

/**
 * #39 Screen Wake Lock — keep the screen awake while WATCHING a live run
 * (a foregrounded terminal with a connected agent, or the Live Wall). Mobile
 * screens otherwise dim and sleep mid-run.
 *
 * Everything is best-effort and fail-silent by design:
 * - Feature-detected: a browser without `navigator.wakeLock` is a silent no-op.
 * - `request()` rejections (NotAllowedError on battery saver, permissions
 *   policy, etc.) are swallowed — a wake lock is never worth an error surface.
 * - The UA auto-releases the sentinel when the tab is hidden; the sentinel's
 *   "release" event only clears our (identity-guarded) reference so we never
 *   hold a dead sentinel — the re-acquire itself happens when the next
 *   visibilitychange sync() sees the lock is gone.
 * - A request() that never settles (broken UA) is raced against a timeout so
 *   the serialized queue can never wedge; a sentinel that resolves after the
 *   timeout is released, never adopted.
 *
 * The DECISION is a pure exported function (`decideWakeLock`) and the async
 * request/release mechanics live in an injectable controller
 * (`createWakeLockController`), so the whole behavior is unit-testable with a
 * plain-object wake-lock API — the React hook is thin wiring on top.
 */

import { useEffect, useRef } from "react";

export type WakeLockDecision = "acquire" | "release" | "hold";

/** Pure policy: what to do given the current inputs. */
export function decideWakeLock({
  active,
  visible,
  hasLock,
}: {
  active: boolean;
  visible: boolean;
  hasLock: boolean;
}): WakeLockDecision {
  if (active && visible) {
    return hasLock ? "hold" : "acquire";
  }
  return hasLock ? "release" : "hold";
}

/** Structural subset of WakeLockSentinel (so tests inject plain objects). */
export interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener?(type: "release", listener: () => void): void;
}

/** Structural subset of navigator.wakeLock. */
export interface WakeLockApiLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

export interface WakeLockController {
  /** Reconcile toward the desired state. Never rejects. */
  sync(active: boolean, visible: boolean): Promise<void>;
  hasLock(): boolean;
}

/**
 * Upper bound on how long an in-flight request() may pend before the queue
 * moves on without it — a hung request (broken UA) must not wedge the
 * serialized queue for the rest of the session. Real requests settle in
 * milliseconds; this only ever fires on a defective implementation.
 */
export const WAKE_LOCK_REQUEST_TIMEOUT_MS = 5_000;

export function createWakeLockController(
  getWakeLock: () => WakeLockApiLike | undefined
): WakeLockController {
  let sentinel: WakeLockSentinelLike | null = null;
  // Latest-wins desired state, updated SYNCHRONOUSLY in sync() so an acquire
  // that was in flight when the state flipped can drop its sentinel on arrival.
  let wantActive = false;
  let wantVisible = false;
  // Serialize acquire/release so they never interleave.
  let queue: Promise<void> = Promise.resolve();

  async function acquire(): Promise<void> {
    let api: WakeLockApiLike | undefined;
    try {
      api = getWakeLock();
    } catch {
      return; // hostile getter — treat as "no API"
    }
    if (!api) return; // feature-detect: silent no-op

    // Normalize every failure mode of request() (sync throw, rejection —
    // NotAllowedError on battery saver, permissions policy, etc.) into one
    // settled shape, so the race below can never leak an unhandled rejection.
    let settled: Promise<WakeLockSentinelLike | null>;
    try {
      settled = Promise.resolve(api.request("screen")).catch(() => null);
    } catch {
      return; // request() threw synchronously
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const winner = await Promise.race([
      settled,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(
          () => resolve("timeout"),
          WAKE_LOCK_REQUEST_TIMEOUT_MS
        );
      }),
    ]);
    clearTimeout(timer);

    if (winner === "timeout") {
      // If the orphaned request EVER resolves, release that sentinel right
      // away. It is deliberately never adopted: adoption would mutate
      // `sentinel` outside the queue and could interleave with a newer
      // in-flight acquire (two live sentinels, one leaked). The next sync()
      // re-acquires if a lock is still wanted.
      void settled.then((late) => {
        if (!late) return;
        try {
          void late.release().catch(() => {});
        } catch {
          /* hostile release — fine */
        }
      });
      return;
    }
    if (winner === null) return; // request() rejected — swallowed above
    const next = winner;

    if (!(wantActive && wantVisible)) {
      // State flipped while the request was in flight — don't keep it.
      try {
        await next.release();
      } catch {
        /* already released — fine */
      }
      return;
    }
    sentinel = next;
    // The UA auto-releases on tab hide / battery saver. Track it so the next
    // sync() re-acquires instead of "holding" a dead sentinel.
    next.addEventListener?.("release", () => {
      if (sentinel === next) sentinel = null;
    });
  }

  async function release(): Promise<void> {
    const current = sentinel;
    sentinel = null;
    if (!current) return;
    try {
      await current.release();
    } catch {
      /* already released — fine */
    }
  }

  function sync(active: boolean, visible: boolean): Promise<void> {
    wantActive = active;
    wantVisible = visible;
    queue = queue
      .then(() => {
        const decision = decideWakeLock({
          active: wantActive,
          visible: wantVisible,
          hasLock: sentinel !== null,
        });
        if (decision === "acquire") return acquire();
        if (decision === "release") return release();
        return undefined;
      })
      .catch(() => {
        /* defensive: the queue must never wedge */
      });
    return queue;
  }

  return { sync, hasLock: () => sentinel !== null };
}

/**
 * Hold a screen wake lock while `active` and the document is visible.
 * Releases on !active/unmount/tab-hide, re-acquires on visibilitychange back.
 * SSR-safe and a silent no-op without the Wake Lock API.
 */
export function useWakeLock(active: boolean): void {
  const controllerRef = useRef<WakeLockController | null>(null);

  useEffect(() => {
    // Effects never run during SSR, but keep the guard so the hook can never
    // throw in an odd environment (spec: never throws during SSR).
    if (typeof document === "undefined" || typeof navigator === "undefined") {
      return;
    }
    controllerRef.current ??= createWakeLockController(
      () => (navigator as Navigator & { wakeLock?: WakeLockApiLike }).wakeLock
    );
    const controller = controllerRef.current;
    const update = () => {
      void controller.sync(active, document.visibilityState === "visible");
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      void controller.sync(false, false);
    };
  }, [active]);
}
